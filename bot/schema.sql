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

-- Where this user actually talks to the bot (2026-09-11). It is NOT the same as
-- telegram_id: in a group, telegram_id is the person and chat_id is the group,
-- and a person who has never opened a private chat cannot be messaged by their
-- user id at all ("Bad Request: chat not found"). Every outbound message uses
-- this, refreshed on every update the user sends.
alter table users add column if not exists chat_id text;

-- Telegram has refused to deliver to this user (2026-09-11). Someone who has
-- never opened a private chat with the bot answers "chat not found" — or
-- "can't initiate conversation with a user" — for every message, forever. That
-- is a state, not an error: it is recorded on the first refusal, every later
-- message for them is skipped without an API call, and any update they send
-- clears it. Their buys still run while it is set; they just hear nothing.
alter table users add column if not exists unreachable_at     timestamptz;
alter table users add column if not exists unreachable_reason text;

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
-- Fee on every buy (2026-09-05): 1% of the tokens bought, paid to the treasury inside the swap.
alter table trades add column if not exists fee_bips      int;      -- fee requested, basis points (100 = 1%)
alter table trades add column if not exists fee_recipient text;     -- treasury address the fee went to
alter table trades add column if not exists fee_amount    numeric;  -- raw token units to the treasury (quoted, then actual from the receipt)
alter table trades add column if not exists tokens_out    numeric;  -- raw token units to the user (same rule)
-- Retries (2026-09-11): a buy that fails for a transient reason is retried in the
-- background up to config.MAX_BUY_ATTEMPTS times instead of being abandoned, and
-- the user watches one message change rather than receiving one per attempt.
alter table trades add column if not exists attempts       int not null default 0;  -- attempts finished so far
alter table trades add column if not exists next_retry_at  timestamptz;             -- when status = 'retrying'
alter table trades add column if not exists error_code     text;                    -- errors.js code of the last failure
alter table trades add column if not exists chat_id        text;                    -- chat holding the status message
alter table trades add column if not exists status_msg_id  bigint;                  -- message edited in place
alter table trades add column if not exists updated_at     timestamptz default now();
create index if not exists trades_due_idx on trades (status, next_retry_at);
create index if not exists trades_user_idx on trades (telegram_id, created_at desc);

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
-- The question currently on screen, so answering it can delete both the question
-- and the answer and leave only the result (see src/ui.js).
alter table conversations add column if not exists prompt_chat_id text;
alter table conversations add column if not exists prompt_msg_id  bigint;
