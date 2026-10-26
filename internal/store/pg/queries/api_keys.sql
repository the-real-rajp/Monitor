-- name: CreateAPIKey :one
INSERT INTO api_keys (org_id, name, prefix, key_hash, scopes, created_by)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: GetAPIKeyByPrefix :one
SELECT * FROM api_keys WHERE prefix = $1 AND revoked_at IS NULL;

-- name: GetAPIKey :one
SELECT * FROM api_keys WHERE id = $1 AND org_id = $2;

-- name: ListAPIKeysByOrg :many
SELECT * FROM api_keys WHERE org_id = $1 ORDER BY created_at DESC, id;

-- name: TouchAPIKey :exec
UPDATE api_keys SET last_used_at = now() WHERE id = $1;

-- name: RevokeAPIKey :execrows
UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL;
