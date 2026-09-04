-- Moonbag bot ledger. Idempotent: run at every boot.
create table if not exists users (
  telegram_id     text primary key,
  address         text not null,
  key_iv          text,
  key_ct          text,
  key_tag         text,
  buy_amount_wei  numeric not null,
  created_at      timestamptz default now()
);

create table if not exists watched_wallets (
  id           serial primary key,
  telegram_id  text references users,
  address      text not null,
  added_at     timestamptz default now(),
  unique (telegram_id, address)
);
create index if not exists watched_wallets_address_idx on watched_wallets (address);

create table if not exists positions (
  watched_wallet_id  int references watched_wallets on delete cascade,
  token              text,
  baseline_amount    numeric not null,
  updated_at         timestamptz default now(),
  primary key (watched_wallet_id, token)
);

create table if not exists watcher_state (
  telegram_id   text primary key references users,
  enabled       boolean not null default false,
  last_poll_at  timestamptz
);

create table if not exists trades (
  sell_key     text primary key,
  telegram_id  text,
  token        text,
  eth_in_wei   numeric,
  buy_tx_hash  text,
  status       text not null,
  error        text,
  created_at   timestamptz default now()
);

create table if not exists tokens (
  address     text primary key,
  symbol      text,
  decimals    int,
  updated_at  timestamptz default now()
);

create table if not exists conversations (
  telegram_id  text primary key,
  awaiting     text,
  updated_at   timestamptz default now()
);
