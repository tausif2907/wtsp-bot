-- Rashmi Boutique WhatsApp bot: its own tables, kept in the online store's Supabase project.
-- Run once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run. Safe to run more than once.
--
-- Before running, put a long random password in place of CHANGE_ME_BOT_PASSWORD (it appears once, near the end).
-- The bot signs in with it: DATABASE_URL in the bot's .env uses the same password (see .env.example).
-- Afterwards, delete the saved query in the SQL Editor so the password isn't kept there.
--
-- Everything lives in a separate "bot" schema. The website, the public (anon) key and shoppers' logins
-- can't see it, and the bot's login can't touch the store's own tables.

-- ================================================================ tables

create schema if not exists bot;

-- Dashboard logins: the boutique admin and delivery staff
create table if not exists bot.staff (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  username text not null unique check (username = lower(username) and char_length(username) between 1 and 60),
  password_hash text not null,
  role text not null default 'admin' check (role in ('admin', 'delivery')),
  created_at timestamptz not null default now()
);

-- Customers who booked through WhatsApp
create table if not exists bot.customers (
  phone_number text primary key,
  name text not null default '',
  location_lat double precision,
  location_lng double precision,
  address text,
  created_at timestamptz not null default now()
);

-- Everyone who messaged the bot or was imported from a CSV, for broadcasts
create table if not exists bot.leads (
  id uuid primary key default gen_random_uuid(),
  phone_number text not null unique,
  name text not null default '',
  type text not null default 'unregistered' check (type in ('registered', 'unregistered')),
  source text not null default 'whatsapp' check (source in ('whatsapp', 'csv_import')),
  last_active timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Stitching bookings and their progress
create table if not exists bot.orders (
  order_id text primary key,
  customer_phone text not null,
  customer_name text not null,
  service text not null,
  booking_date text not null,                  -- as shown to the customer, e.g. "Wed, 4 Nov"
  booking_time text not null,                  -- e.g. "01:00 PM - 03:00 PM"
  appointment_day date,                        -- the same day, for the dashboard's Today view
  appointment_type text not null default 'visit' check (appointment_type in ('visit', 'pickup')),
  latitude double precision,                   -- home pickups only
  longitude double precision,
  address text,
  price integer not null default 0 check (price between 0 and 10000000),   -- 0 until set after measurement
  invoice_number text not null,
  status text not null default 'order_received'
    check (status in ('order_received', 'in_stitching', 'ready', 'out_for_delivery', 'delivered', 'cancelled')),
  notes text not null default '',              -- measurements and design notes for the team
  created_at timestamptz not null default now()
);
create index if not exists orders_created_idx on bot.orders (created_at desc);
create index if not exists orders_customer_idx on bot.orders (customer_phone, created_at desc);

-- Where each customer is in the WhatsApp conversation. The bot ignores rows untouched for 24 hours
-- and clears them out every hour.
create table if not exists bot.sessions (
  phone_number text primary key,
  current_step text not null default 'start',
  name text,
  selected_service text,
  selected_date text,
  selected_day text,
  selected_time text,
  location_lat double precision,
  location_lng double precision,
  address text,
  appointment_type text,
  browse_category text,
  browse_page integer,
  product_id text,
  handoff_at timestamptz,                      -- when the customer asked to talk to the team
  handoff_topic text,
  cart jsonb not null default '[]'::jsonb check (jsonb_typeof(cart) = 'array'),
  updated_at timestamptz not null default now()
);
create index if not exists sessions_step_idx on bot.sessions (current_step, updated_at desc);
create index if not exists sessions_updated_idx on bot.sessions (updated_at);

-- Messages exchanged while a customer talks to the team (the dashboard inbox)
create table if not exists bot.chat_messages (
  id uuid primary key default gen_random_uuid(),
  seq bigserial,                               -- keeps messages from the same moment in the order they arrived
  phone_number text not null,
  direction text not null check (direction in ('in', 'out')),
  text text not null default '',
  media_id text,
  media_type text,
  sent_by text,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_phone_idx on bot.chat_messages (phone_number, created_at desc, seq desc);

-- ================================================================ access

-- The bot's own login. Change the password by editing it here and running this file again.
do $$
declare
  bot_password text := 'CHANGE_ME_BOT_PASSWORD';
begin
  if bot_password like 'CHANGE\_ME%' or char_length(bot_password) < 16 then
    raise exception 'Replace CHANGE_ME_BOT_PASSWORD with a long password (at least 16 characters), then run again.';
  end if;
  if exists (select 1 from pg_roles where rolname = 'rashmi_bot') then
    execute format('alter role rashmi_bot with login password %L connection limit 20', bot_password);
  else
    execute format('create role rashmi_bot with login password %L connection limit 20', bot_password);
  end if;
end $$;

-- Only the bot may use the bot schema
revoke all on schema bot from public;
revoke all on all tables in schema bot from public, anon, authenticated;
revoke all on all sequences in schema bot from public, anon, authenticated;
grant usage on schema bot to rashmi_bot;
grant select, insert, update, delete on all tables in schema bot to rashmi_bot;
grant usage, select on all sequences in schema bot to rashmi_bot;   -- the inbox message counter
alter default privileges in schema bot grant select, insert, update, delete on tables to rashmi_bot;
alter default privileges in schema bot grant usage, select on sequences to rashmi_bot;

-- Row level security as a second lock: only the bot's login gets rows
alter table bot.staff enable row level security;
alter table bot.customers enable row level security;
alter table bot.leads enable row level security;
alter table bot.orders enable row level security;
alter table bot.sessions enable row level security;
alter table bot.chat_messages enable row level security;

drop policy if exists "Only the bot" on bot.staff;
create policy "Only the bot" on bot.staff for all to rashmi_bot using (true) with check (true);
drop policy if exists "Only the bot" on bot.customers;
create policy "Only the bot" on bot.customers for all to rashmi_bot using (true) with check (true);
drop policy if exists "Only the bot" on bot.leads;
create policy "Only the bot" on bot.leads for all to rashmi_bot using (true) with check (true);
drop policy if exists "Only the bot" on bot.orders;
create policy "Only the bot" on bot.orders for all to rashmi_bot using (true) with check (true);
drop policy if exists "Only the bot" on bot.sessions;
create policy "Only the bot" on bot.sessions for all to rashmi_bot using (true) with check (true);
drop policy if exists "Only the bot" on bot.chat_messages;
create policy "Only the bot" on bot.chat_messages for all to rashmi_bot using (true) with check (true);
