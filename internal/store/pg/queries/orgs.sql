-- name: CreateOrg :one
INSERT INTO orgs (name, slug) VALUES ($1, $2) RETURNING *;

-- name: GetOrg :one
SELECT * FROM orgs WHERE id = $1;

-- name: GetOrgBySlug :one
SELECT * FROM orgs WHERE slug = $1;

-- name: CountOrgs :one
SELECT count(*) FROM orgs;
