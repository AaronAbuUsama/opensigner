package main

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type legacyAccount struct {
	gorm.Model
	ID           string `gorm:"primaryKey"`
	Address      string `gorm:"uniqueIndex:idx_account_address"`
	Username     string
	ChainId      int64
	AuthProvider string
	SignerId     string
}

func (legacyAccount) TableName() string { return "accounts" }

func TestLegacyChainTypeMigration(t *testing.T) {
	database, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	checkLegacyChainTypeMigration(t, database)
}

func TestLegacyChainTypeMigrationPostgres(t *testing.T) {
	dsn := os.Getenv("TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("set TEST_POSTGRES_DSN to exercise PostgreSQL")
	}
	connection, err := url.Parse(dsn)
	if err != nil || (connection.Scheme != "postgres" && connection.Scheme != "postgresql") {
		t.Fatal("TEST_POSTGRES_DSN must be a postgres:// URL")
	}
	admin, err := gorm.Open(postgres.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	adminPool, _ := admin.DB()
	t.Cleanup(func() { adminPool.Close() })
	schema := "stellar_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if err := admin.Exec(fmt.Sprintf("CREATE SCHEMA %s", schema)).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { admin.Exec(fmt.Sprintf("DROP SCHEMA %s CASCADE", schema)) })
	query := connection.Query()
	query.Set("search_path", schema)
	connection.RawQuery = query.Encode()
	database, err := gorm.Open(postgres.Open(connection.String()), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	pool, _ := database.DB()
	t.Cleanup(func() { pool.Close() })
	checkLegacyChainTypeMigration(t, database)
}

func checkLegacyChainTypeMigration(t *testing.T, database *gorm.DB) {
	t.Helper()
	if err := database.AutoMigrate(&legacyAccount{}); err != nil {
		t.Fatal(err)
	}
	fixtures := []legacyAccount{
		{ID: "evm", Address: "0x0000000000000000000000000000000000000001", Username: "alice", ChainId: 80002, AuthProvider: "default", SignerId: "evm-signer"},
		{ID: "svm", Address: "Hg8WDiQvChwxoWENQic7oGCcwKd4BNBNdot2Wvwm7VMr", Username: "bob", AuthProvider: "google", SignerId: "svm-signer"},
		{Model: gorm.Model{DeletedAt: gorm.DeletedAt{Time: time.Unix(1700000000, 0), Valid: true}}, ID: "svm-deleted", Address: "EbSYVaVg1VAVsHJtg56NV4SdPkmqVaAohq7vEgPvi7v7", Username: "carol", AuthProvider: "default", SignerId: "deleted-signer"},
	}
	if err := database.Create(&fixtures).Error; err != nil {
		t.Fatal(err)
	}
	failure := errors.New("forced backfill failure")
	if err := database.Callback().Update().Before("gorm:update").Register("test:fail-backfill", func(tx *gorm.DB) { tx.AddError(failure) }); err != nil {
		t.Fatal(err)
	}
	if err := migrateAccountChainTypes(database); !errors.Is(err, failure) {
		t.Fatalf("forced migration failure = %v", err)
	}
	if database.Migrator().HasColumn(&Account{}, "chain_type") {
		t.Fatal("failed migration committed the chain_type column")
	}
	if err := database.Callback().Update().Remove("test:fail-backfill"); err != nil {
		t.Fatal(err)
	}
	if err := migrateAccountChainTypes(database); err != nil {
		t.Fatal(err)
	}
	var accounts []Account
	if err := database.Unscoped().Order("id").Find(&accounts).Error; err != nil {
		t.Fatal(err)
	}
	if len(accounts) != len(fixtures) {
		t.Fatalf("migration preserved %d rows, want %d", len(accounts), len(fixtures))
	}
	for i, account := range accounts {
		fixture := fixtures[i]
		want := "EVM"
		if strings.HasPrefix(account.ID, "svm") {
			want = "SVM"
		}
		if account.ChainType != want {
			t.Fatalf("account %s chain type = %s, want %s", account.ID, account.ChainType, want)
		}
		if account.ID != fixture.ID || account.Address != fixture.Address || account.Username != fixture.Username || account.ChainId != fixture.ChainId || account.AuthProvider != fixture.AuthProvider || account.SignerId != fixture.SignerId || account.DeletedAt.Valid != fixture.DeletedAt.Valid {
			t.Fatalf("migration changed existing data for %s", fixture.ID)
		}
	}
	var legacyReader []legacyAccount
	if err := database.Unscoped().Order("id").Find(&legacyReader).Error; err != nil || len(legacyReader) != len(fixtures) {
		t.Fatalf("legacy reader after upgrade: %v, rows=%d", err, len(legacyReader))
	}
	oldWriter := legacyAccount{ID: "evm-new", Address: "0x0000000000000000000000000000000000000002", Username: "alice", AuthProvider: "default"}
	if err := database.Create(&oldWriter).Error; err != nil {
		t.Fatalf("legacy EVM writer after upgrade: %v", err)
	}
	var newlyRead Account
	if err := database.First(&newlyRead, "id = ?", oldWriter.ID).Error; err != nil || newlyRead.ChainType != "EVM" {
		t.Fatalf("new reader of legacy EVM write: %v, chain type=%s", err, newlyRead.ChainType)
	}
	if err := migrateAccountChainTypes(database); err != nil {
		t.Fatalf("migration retry: %v", err)
	}
}
