package main

import (
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

func TestLegacyChainTypeMigration(t *testing.T) {
	database, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Exec(`CREATE TABLE accounts (
		id TEXT PRIMARY KEY, created_at DATETIME, updated_at DATETIME, deleted_at DATETIME,
		address TEXT, username TEXT, chain_id INTEGER, auth_provider TEXT, signer_id TEXT
	)`).Error; err != nil {
		t.Fatal(err)
	}
	for id, address := range map[string]string{
		"evm": "0x0000000000000000000000000000000000000001",
		"svm": "Hg8WDiQvChwxoWENQic7oGCcwKd4BNBNdot2Wvwm7VMr",
	} {
		if err := database.Exec("INSERT INTO accounts (id, address) VALUES (?, ?)", id, address).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := migrateAccountChainTypes(database); err != nil {
		t.Fatal(err)
	}
	var accounts []Account
	if err := database.Find(&accounts).Error; err != nil {
		t.Fatal(err)
	}
	for _, account := range accounts {
		want := "EVM"
		if account.ID == "svm" {
			want = "SVM"
		}
		if account.ChainType != want {
			t.Fatalf("account %s chain type = %s, want %s", account.ID, account.ChainType, want)
		}
	}
	if err := migrateAccountChainTypes(database); err != nil {
		t.Fatalf("migration retry: %v", err)
	}
}
