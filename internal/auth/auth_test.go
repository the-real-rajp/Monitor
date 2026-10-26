package auth

import (
	"strings"
	"testing"
)

func TestPasswordRoundTrip(t *testing.T) {
	h, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "$argon2id$v=19$") {
		t.Fatalf("unexpected hash format: %s", h)
	}
	if !VerifyPassword(h, "correct horse battery staple") {
		t.Error("correct password rejected")
	}
	if VerifyPassword(h, "correct horse battery stapl") {
		t.Error("wrong password accepted")
	}
	if VerifyPassword("", "anything") || VerifyPassword("$argon2id$garbage", "anything") {
		t.Error("malformed hash accepted")
	}
}

func TestHashIsSalted(t *testing.T) {
	a, _ := HashPassword("same password here")
	b, _ := HashPassword("same password here")
	if a == b {
		t.Error("two hashes of the same password are identical; salt missing")
	}
}

func TestValidatePassword(t *testing.T) {
	if err := ValidatePassword("short"); err == nil {
		t.Error("short password accepted")
	}
	if err := ValidatePassword(strings.Repeat("x", MinPasswordLength)); err != nil {
		t.Errorf("minimum-length password rejected: %v", err)
	}
	if err := ValidatePassword(strings.Repeat("x", 2000)); err == nil {
		t.Error("absurdly long password accepted")
	}
}

func TestSessionToken(t *testing.T) {
	tok, hash, err := NewSessionToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(tok) != 43 {
		t.Errorf("token length %d, want 43", len(tok))
	}
	if string(HashToken(tok)) != string(hash) {
		t.Error("HashToken does not match returned hash")
	}
	tok2, _, _ := NewSessionToken()
	if tok == tok2 {
		t.Error("two tokens identical")
	}
}

func TestAPIKey(t *testing.T) {
	key, prefix, hash, err := NewAPIKey()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(key, "mon_"+prefix+"_") {
		t.Errorf("key %q does not carry prefix %q", key, prefix)
	}
	p2, h2, err := ParseAPIKey(key)
	if err != nil {
		t.Fatal(err)
	}
	if p2 != prefix || string(h2) != string(hash) {
		t.Error("parsed key does not round-trip")
	}
	for _, bad := range []string{"", "mon_", "mon_abc_def", "xxx_" + prefix + "_" + strings.Repeat("a", 64), key + "ff", key[:len(key)-1], "mon_zzzzzzzzzzzz_" + strings.Repeat("a", 64)} {
		if _, _, err := ParseAPIKey(bad); err == nil {
			t.Errorf("malformed key %q accepted", bad)
		}
	}
}
