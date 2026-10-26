-- name: CreateUser :one
INSERT INTO users (org_id, email, name, role, password_hash)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: GetUser :one
SELECT * FROM users WHERE id = $1;

-- name: GetUserByEmail :one
SELECT * FROM users WHERE lower(email) = lower($1);

-- name: ListUsersByOrg :many
SELECT * FROM users WHERE org_id = $1 ORDER BY created_at, id;

-- name: CountUsersByOrgAndRole :one
SELECT count(*) FROM users WHERE org_id = $1 AND role = $2 AND disabled_at IS NULL;

-- name: UpdateUser :one
UPDATE users
SET name = coalesce(sqlc.narg('name'), name),
    role = coalesce(sqlc.narg('role'), role),
    updated_at = now()
WHERE id = $1 AND org_id = $2
RETURNING *;

-- name: SetUserPassword :exec
UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1;

-- name: SetUserDisabled :one
UPDATE users
SET disabled_at = CASE WHEN sqlc.arg('disabled')::boolean THEN now() ELSE NULL END,
    updated_at = now()
WHERE id = $1 AND org_id = $2
RETURNING *;

-- name: DeleteUser :execrows
DELETE FROM users WHERE id = $1 AND org_id = $2;
