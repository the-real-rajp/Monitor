-- Telemetry schema, phase 0: raw metrics plus 5-minute and 1-hour rollups.
-- Phase 0 only writes the server's own metrics here; phase 2 opens it to agents.
--
-- Statements are separated by a line containing only "-- ;;" because
-- ClickHouse executes one statement per query.

CREATE TABLE IF NOT EXISTS metrics_raw
(
    org_id      UUID,
    metric      LowCardinality(String),
    resource_id String,
    labels      Map(LowCardinality(String), String),
    ts          DateTime64(3, 'UTC'),
    value       Float64
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (org_id, metric, resource_id, ts)
TTL toDateTime(ts) + INTERVAL 15 DAY
SETTINGS index_granularity = 8192;

-- ;;

CREATE TABLE IF NOT EXISTS metrics_5m
(
    org_id      UUID,
    metric      LowCardinality(String),
    resource_id String,
    labels      Map(LowCardinality(String), String),
    bucket      DateTime('UTC'),
    min         SimpleAggregateFunction(min, Float64),
    max         SimpleAggregateFunction(max, Float64),
    sum         SimpleAggregateFunction(sum, Float64),
    count       SimpleAggregateFunction(sum, UInt64),
    last        AggregateFunction(argMax, Float64, DateTime64(3, 'UTC'))
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket)
ORDER BY (org_id, metric, resource_id, labels, bucket)
TTL bucket + INTERVAL 90 DAY;

-- ;;

CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_5m_mv TO metrics_5m AS
SELECT
    org_id,
    metric,
    resource_id,
    labels,
    toStartOfFiveMinutes(ts) AS bucket,
    min(value)               AS min,
    max(value)               AS max,
    sum(value)               AS sum,
    toUInt64(count())        AS count,
    argMaxState(value, ts)   AS last
FROM metrics_raw
GROUP BY org_id, metric, resource_id, labels, bucket;

-- ;;

CREATE TABLE IF NOT EXISTS metrics_1h
(
    org_id      UUID,
    metric      LowCardinality(String),
    resource_id String,
    labels      Map(LowCardinality(String), String),
    bucket      DateTime('UTC'),
    min         SimpleAggregateFunction(min, Float64),
    max         SimpleAggregateFunction(max, Float64),
    sum         SimpleAggregateFunction(sum, Float64),
    count       SimpleAggregateFunction(sum, UInt64),
    last        AggregateFunction(argMax, Float64, DateTime64(3, 'UTC'))
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket)
ORDER BY (org_id, metric, resource_id, labels, bucket)
TTL bucket + INTERVAL 2 YEAR;

-- ;;

CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_1h_mv TO metrics_1h AS
SELECT
    org_id,
    metric,
    resource_id,
    labels,
    toStartOfHour(ts)        AS bucket,
    min(value)               AS min,
    max(value)               AS max,
    sum(value)               AS sum,
    toUInt64(count())        AS count,
    argMaxState(value, ts)   AS last
FROM metrics_raw
GROUP BY org_id, metric, resource_id, labels, bucket;
