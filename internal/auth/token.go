package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
)

// Session tokens are 32 random bytes, base64url-encoded, handed to the
// browser in an HttpOnly cookie. Only the SHA-256 of the token is stored.

const sessionTokenBytes = 32

// NewSessionToken returns a fresh token and its storage hash.
func NewSessionToken() (token string, hash []byte, err error) {
	raw := make([]byte, sessionTokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", nil, err
	}
	token = base64.RawURLEncoding.EncodeToString(raw)
	return token, HashToken(token), nil
}

// HashToken is the storage hash for session tokens and API key secrets.
func HashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// API keys look like  mon_<prefix>_<secret>  where prefix is 12 hex
// characters used to find the row and secret is 32 random bytes as 64 hex
// characters. Hex keeps the separator out of both parts. Only the hash of
// the whole key is stored, so a database leak does not leak usable keys.

const (
	apiKeyScheme      = "mon"
	apiKeyPrefixBytes = 6
	apiKeyPrefixLen   = 2 * apiKeyPrefixBytes
	apiKeySecretBytes = 32
	apiKeySecretLen   = 2 * apiKeySecretBytes
)

// ErrMalformedAPIKey is returned by ParseAPIKey.
var ErrMalformedAPIKey = errors.New("malformed api key")

// NewAPIKey returns a fresh key, its public prefix and its storage hash.
func NewAPIKey() (key, prefix string, hash []byte, err error) {
	raw := make([]byte, apiKeyPrefixBytes+apiKeySecretBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", "", nil, err
	}
	prefix = hex.EncodeToString(raw[:apiKeyPrefixBytes])
	secret := hex.EncodeToString(raw[apiKeyPrefixBytes:])
	key = apiKeyScheme + "_" + prefix + "_" + secret
	return key, prefix, HashToken(key), nil
}

// ParseAPIKey extracts the prefix from a presented key and returns the hash
// to compare against storage.
func ParseAPIKey(key string) (prefix string, hash []byte, err error) {
	rest, ok := strings.CutPrefix(key, apiKeyScheme+"_")
	if !ok || len(rest) != apiKeyPrefixLen+1+apiKeySecretLen || rest[apiKeyPrefixLen] != '_' {
		return "", nil, ErrMalformedAPIKey
	}
	prefix = rest[:apiKeyPrefixLen]
	if _, err := hex.DecodeString(prefix); err != nil {
		return "", nil, ErrMalformedAPIKey
	}
	if _, err := hex.DecodeString(rest[apiKeyPrefixLen+1:]); err != nil {
		return "", nil, ErrMalformedAPIKey
	}
	return prefix, HashToken(key), nil
}
