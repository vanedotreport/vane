-- Vane — schema.
--
-- Two ideas shape this:
--
--   1. CREATOR CANDIDATES ARE STORED, NOT JUST THE ANSWER. Attribution names a person, the rule
--      for deriving it has already been wrong once, and re-indexing to change your mind is
--      expensive. Every input is kept so `creator` can be recomputed from stored rows.
--
--   2. THE PIPELINE REPORTS ITS OWN HEALTH. vane_runs carries the census and the filter funnel as
--      real columns. Every bug found so far returned a plausible wrong answer rather than an
--      error, and the only things that caught them were "do the buckets sum to the total" and
--      "which filter stage ate everything". Those belong in the database, not in a log line.

-- ---------------------------------------------------------------------------
-- tokens
-- ---------------------------------------------------------------------------
create table if not exists vane_mints (
  mint                    text primary key,
  slot                    bigint      not null,
  block_time              timestamptz,
  signature               text        not null,
  decimals                smallint,

  -- creator attribution. `creator` is NULL when it cannot be determined, and that is a valid,
  -- intended answer — see creator_source = 'unresolved'. Never fall back to fee payer.
  creator                 text,
  creator_source          text        not null default 'unresolved'
                            check (creator_source in ('sole_signer','signer_not_payer','unresolved')),
  creator_candidates      text[]      not null default '{}',
  fee_payer               text,

  -- authority state AT THE END of the creating transaction, not at initializeMint. Launchpads
  -- revoke via setAuthority a few instructions later, so reading the init value describes a
  -- moment that had already passed.
  mint_authority_at_init  text,
  mint_authority_revoked  boolean     not null default false,
  freeze_authority        text,
  initial_recipient       text,

  venue                   text[]      not null default '{}',
  primary_venue           text,
  inner_instruction       boolean     not null default true,
  indexed_at              timestamptz not null default now()
);

create index if not exists vane_mints_slot        on vane_mints (slot desc);
create index if not exists vane_mints_creator     on vane_mints (creator) where creator is not null;
create index if not exists vane_mints_venue       on vane_mints (primary_venue);
create index if not exists vane_mints_block_time  on vane_mints (block_time desc);
-- the freeze-authority-set signal, cheap to ask for
create index if not exists vane_mints_freezable   on vane_mints (mint) where freeze_authority is not null;

-- ---------------------------------------------------------------------------
-- outcomes, resolved repeatedly over a token's life
-- ---------------------------------------------------------------------------
create table if not exists vane_outcomes (
  mint              text        not null references vane_mints(mint) on delete cascade,
  checked_at        timestamptz not null default now(),
  age_hours         numeric,
  tx_count          integer,
  last_activity     timestamptz,
  silent_hours      numeric,
  top_holder_share  numeric,

  -- volume gate. A token nobody traded cannot be rugged, and mixing those into any rate makes it
  -- meaningless — 21 of 47 tokens in the first sample had under 10 transactions and were pure
  -- noise in every correlation.
  volume_quote      numeric,
  peak_liquidity    numeric,
  current_liquidity numeric,
  passed_gate       boolean     not null default false,

  -- 'finished' conflated two different deaths: never_launched (nobody came) and drained
  -- (everybody came, then left). A due-diligence report must answer those differently.
  status            text        not null
                      check (status in ('never_launched','live','fading','silent','drained')),
  primary key (mint, checked_at)
);

create index if not exists vane_outcomes_latest on vane_outcomes (mint, checked_at desc);
create index if not exists vane_outcomes_status on vane_outcomes (status, checked_at desc);

-- ---------------------------------------------------------------------------
-- the death event — one row per venue, never merged across pools
-- ---------------------------------------------------------------------------
create table if not exists vane_extractions (
  id              bigserial primary key,
  mint            text        not null references vane_mints(mint) on delete cascade,
  pool            text        not null,
  quote_mint      text        not null,
  slot            bigint      not null,
  block_time      timestamptz,
  signature       text        not null,
  seller          text        not null,
  took_quote      numeric     not null,
  pool_before     numeric     not null,
  share           numeric     not null,   -- took_quote / pool_before
  peak_liquidity  numeric     not null,
  -- the absolute floor this had to clear. Recorded so a published figure can be re-derived, and
  -- because a share with no floor is how a two-lamport trade scored 66.7%.
  floor_applied   numeric     not null,
  detector        text        not null default 'extraction/v1',
  unique (mint, pool, signature)
);

create index if not exists vane_extractions_mint on vane_extractions (mint);

-- ---------------------------------------------------------------------------
-- pipeline health. Not logging — a table, because these numbers are evidence.
-- ---------------------------------------------------------------------------
create table if not exists vane_runs (
  id                    bigserial primary key,
  kind                  text        not null check (kind in ('index','resolve','extract')),
  started_at            timestamptz not null default now(),
  finished_at           timestamptz,
  from_slot             bigint,
  to_slot               bigint,

  blocks_seen           integer not null default 0,
  blocks_missing        integer not null default 0,

  -- census: every transaction lands in exactly one bucket, and they must sum to tx_total.
  tx_total              integer not null default 0,
  tx_failed             integer not null default 0,
  tx_no_token_balances  integer not null default 0,
  tx_no_vault_pair      integer not null default 0,
  tx_swap               integer not null default 0,
  reconciled            boolean,

  mints_found           integer not null default 0,
  mints_inner           integer not null default 0,
  mints_top_level       integer not null default 0,
  creators_resolved     integer not null default 0,
  creators_unresolved   integer not null default 0,

  funnel                jsonb,      -- per-stage rejection counts
  error                 text
);

create index if not exists vane_runs_kind on vane_runs (kind, started_at desc);

-- A run whose buckets do not sum is a silent drop. Flag it at write time rather than hoping
-- somebody reads a dashboard.
create or replace function vane_check_census() returns trigger language plpgsql as $$
begin
  if new.finished_at is not null then
    new.reconciled :=
      (new.tx_failed + new.tx_no_token_balances + new.tx_no_vault_pair + new.tx_swap) = new.tx_total;
  end if;
  return new;
end $$;

drop trigger if exists vane_runs_census on vane_runs;
create trigger vane_runs_census before insert or update on vane_runs
  for each row execute function vane_check_census();

-- ---------------------------------------------------------------------------
-- the launchpad league table — the thing that ships first, because it needs no prediction
-- ---------------------------------------------------------------------------
create or replace view vane_venue_survival as
with latest as (
  select distinct on (mint) mint, status, passed_gate, volume_quote, checked_at
    from vane_outcomes order by mint, checked_at desc
)
select
  m.primary_venue                                              as venue,
  count(*)                                                     as launches,
  count(*) filter (where l.passed_gate)                        as reached_volume,
  count(*) filter (where l.status = 'never_launched')          as never_launched,
  count(*) filter (where l.status in ('silent','drained'))     as dead,
  count(*) filter (where l.status = 'live')                    as still_live,
  round(100.0 * count(*) filter (where l.status = 'live')
        / nullif(count(*) filter (where l.passed_gate), 0), 1) as survival_pct_of_traded,
  count(*) filter (where m.freeze_authority is not null)       as freezable
from vane_mints m
join latest l using (mint)
group by m.primary_venue
having count(*) >= 20      -- never publish a rate whose denominator is too small to mean anything
order by launches desc;

comment on view vane_venue_survival is
  'Survival by launchpad. Rates are over tokens that ACTUALLY TRADED (passed_gate); tokens nobody
   bought are counted separately as never_launched rather than folded in, since they inflate any
   death rate. Venues with fewer than 20 launches are withheld — a percentage over a handful of
   tokens is not a measurement.';
