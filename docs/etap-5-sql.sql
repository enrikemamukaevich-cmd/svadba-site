-- ============================================================================
-- Этап 5. Лайки, комментарии, жалобы — программы внутри базы.
--
-- Правило то же, что и у delete_photo с этапа 4: всё, что зависит от «кто это»,
-- решается внутри базы. Браузер присылает только скрытый ключ гостя, guest_id
-- из браузера доверенным не считается. Каждая программа сама находит гостя
-- по ключу, сама проверяет запрет и сама отказывает забаненному.
--
-- Выполняется один раз в SQL-редакторе Supabase. Запуск повторно безопасен:
-- всё написано через create or replace, а права снимаются и выдаются заново.
-- ============================================================================


-- --------------------------------------------------------------------------
-- 0. Кто это. Общий помощник: id гостя по скрытому ключу, и только если гость
--    не забанен. Наружу не отдаётся — право на вызов у него снято, работает он
--    лишь внутри программ ниже, которые идут от имени владельца базы.
-- --------------------------------------------------------------------------

create or replace function guest_by_key(p_secret uuid)
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select id from guests
  where secret = p_secret and coalesce(banned, false) = false
$$;

revoke all on function guest_by_key(uuid) from public;
revoke all on function guest_by_key(uuid) from anon;


-- --------------------------------------------------------------------------
-- 1. Лайк. Одно нажатие ставит, второе снимает. Возвращает новое число лайков
--    у снимка и своё состояние — на него опирается закраска сердца.
--    Один гость на одно фото — один лайк: это держит составной ключ таблицы,
--    а здесь мы просто сначала пробуем снять, и только если снимать было
--    нечего — ставим.
-- --------------------------------------------------------------------------

create or replace function toggle_like(p_secret uuid, p_photo_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_guest uuid;
  v_liked boolean;
  v_count int;
begin
  v_guest := guest_by_key(p_secret);
  if v_guest is null then
    return jsonb_build_object('ok', false, 'error', 'no_guest');
  end if;

  if not exists (select 1 from photos where id = p_photo_id) then
    return jsonb_build_object('ok', false, 'error', 'no_photo');
  end if;

  delete from likes where photo_id = p_photo_id and guest_id = v_guest;
  if found then
    v_liked := false;
  else
    insert into likes (photo_id, guest_id) values (p_photo_id, v_guest);
    v_liked := true;
  end if;

  select count(*) into v_count from likes where photo_id = p_photo_id;

  return jsonb_build_object('ok', true, 'liked', v_liked, 'likes', v_count);
end $$;

revoke all on function toggle_like(uuid, uuid) from public;
grant execute on function toggle_like(uuid, uuid) to anon;


-- --------------------------------------------------------------------------
-- 2. Комментарий. Длина и непустота проверяются здесь, а не только в браузере:
--    браузерную проверку обходят, эту — нет. Возвращается готовая запись
--    вместе с ником автора, чтобы странице не пришлось ходить за ним отдельно.
-- --------------------------------------------------------------------------

create or replace function add_comment(p_secret uuid, p_photo_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_guest uuid;
  v_body  text;
  v_row   comments%rowtype;
  v_nick  text;
begin
  v_guest := guest_by_key(p_secret);
  if v_guest is null then
    return jsonb_build_object('ok', false, 'error', 'no_guest');
  end if;

  v_body := btrim(coalesce(p_body, ''));
  if v_body = '' then
    return jsonb_build_object('ok', false, 'error', 'empty');
  end if;
  if char_length(v_body) > 200 then
    return jsonb_build_object('ok', false, 'error', 'too_long');
  end if;

  if not exists (select 1 from photos where id = p_photo_id and coalesce(hidden, false) = false) then
    return jsonb_build_object('ok', false, 'error', 'no_photo');
  end if;

  insert into comments (photo_id, guest_id, body)
  values (p_photo_id, v_guest, v_body)
  returning * into v_row;

  select nick into v_nick from guests where id = v_guest;

  return jsonb_build_object('ok', true, 'comment', jsonb_build_object(
    'id',         v_row.id,
    'photo_id',   v_row.photo_id,
    'guest_id',   v_row.guest_id,
    'body',       v_row.body,
    'created_at', v_row.created_at,
    'nick',       v_nick
  ));
end $$;

revoke all on function add_comment(uuid, uuid, text) from public;
grant execute on function add_comment(uuid, uuid, text) to anon;


-- --------------------------------------------------------------------------
-- 3. Удаление своего комментария. Сделано по образцу delete_photo: условие
--    guest_id = свой стоит прямо в delete, поэтому чужую запись стереть нечем.
-- --------------------------------------------------------------------------

create or replace function delete_comment(p_secret uuid, p_comment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_guest uuid;
begin
  v_guest := guest_by_key(p_secret);
  if v_guest is null then
    return jsonb_build_object('ok', false, 'error', 'no_guest');
  end if;

  delete from comments where id = p_comment_id and guest_id = v_guest;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_yours');
  end if;

  return jsonb_build_object('ok', true);
end $$;

revoke all on function delete_comment(uuid, uuid) from public;
grant execute on function delete_comment(uuid, uuid) to anon;


-- --------------------------------------------------------------------------
-- 4. Жалоба. Одна от одного гостя на одно фото. Считаем все жалобы на снимок
--    и на третьей ставим hidden = true — снимок пропадает из ленты и из
--    карточки гостя, но не удаляется: его разберёт панель владельца.
--    Уже поднятый флаг обратно не снимаем.
-- --------------------------------------------------------------------------

create or replace function add_report(p_secret uuid, p_photo_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_guest  uuid;
  v_new    boolean;
  v_count  int;
  v_hidden boolean;
begin
  v_guest := guest_by_key(p_secret);
  if v_guest is null then
    return jsonb_build_object('ok', false, 'error', 'no_guest');
  end if;

  if not exists (select 1 from photos where id = p_photo_id) then
    return jsonb_build_object('ok', false, 'error', 'no_photo');
  end if;

  if exists (select 1 from reports where photo_id = p_photo_id and guest_id = v_guest) then
    v_new := false;
  else
    insert into reports (photo_id, guest_id) values (p_photo_id, v_guest);
    v_new := true;
  end if;

  select count(*) into v_count from reports where photo_id = p_photo_id;

  update photos
     set reports = v_count,
         hidden  = coalesce(hidden, false) or v_count >= 3
   where id = p_photo_id
  returning hidden into v_hidden;

  return jsonb_build_object('ok', true, 'already', not v_new,
                            'reports', v_count, 'hidden', coalesce(v_hidden, false));
end $$;

revoke all on function add_report(uuid, uuid) from public;
grant execute on function add_report(uuid, uuid) to anon;


-- --------------------------------------------------------------------------
-- 5. Свои лайки на целую порцию ленты. Возвращает те из присланных снимков,
--    которые этот гость уже лайкнул. Один вызов на двенадцать карточек —
--    иначе сердечки пришлось бы спрашивать по одному.
--    Чужие лайки так не узнать: список фильтруется по гостю из ключа.
-- --------------------------------------------------------------------------

create or replace function my_likes(p_secret uuid, p_photo_ids uuid[])
returns uuid[]
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(array_agg(l.photo_id), '{}'::uuid[])
  from likes l
  where l.guest_id = guest_by_key(p_secret)
    and l.photo_id = any (coalesce(p_photo_ids, '{}'::uuid[]))
$$;

revoke all on function my_likes(uuid, uuid[]) from public;
grant execute on function my_likes(uuid, uuid[]) to anon;


-- --------------------------------------------------------------------------
-- 6. Лишние права. До этого этапа публичная роль могла писать в likes,
--    comments и reports напрямую, в обход программ выше, — то есть лайкнуть
--    от чужого имени, оставить комментарий любой длины и нажаловаться дважды.
--    Забираем: остаётся только чтение, а изменения идут через программы.
--
--    INSERT в photos не трогаем — на нём держится загрузка снимков этапа 4.
--    UPDATE на photos публичной роли не выдан и раньше, проверено.
-- --------------------------------------------------------------------------

revoke insert, update, delete on table likes    from anon;
revoke insert, update, delete on table comments from anon;
revoke insert, update, delete on table reports  from anon;

revoke update, delete on table photos from anon;
revoke update, delete on table guests from anon;

-- Чтение остаётся: лента считает лайки и комментарии обычным запросом.
grant select on table likes    to anon;
grant select on table comments to anon;
grant select on table reports  to anon;
