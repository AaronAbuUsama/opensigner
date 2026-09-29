package main

import (
	"fmt"
	"log/slog"
	"math/big"
	"os"
	"strings"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

var db *gorm.DB

// Connects to Postgres using environment variables DB_HOST, DB_PORT, DB_NAME.
func initDB() error {
	slog.Info("Initializing DB")
	host := os.Getenv("DB_HOST")
	port := os.Getenv("DB_PORT")
	name := os.Getenv("DB_NAME")
	user := os.Getenv("DB_USER")
	password := os.Getenv("DB_PASS")

	if host == "" || port == "" || name == "" || user == "" {
		return fmt.Errorf("DB_HOST, DB_PORT, DB_NAME, and DB_USER environment variables must be set")
	}

	sslmode := os.Getenv("DB_SSLMODE")
	if sslmode == "" {
		sslmode = "require"
	}
	dsn := fmt.Sprintf("postgres://%s:%s@%s:%s/%s?sslmode=%s", user, password, host, port, name, sslmode)
	newDB, err := gorm.Open(postgres.New(postgres.Config{
		DSN:                  dsn,
		PreferSimpleProtocol: true,
	}), &gorm.Config{})
	if err != nil {
		return err
	}
	if err := newDB.AutoMigrate(&Device{}); err != nil {
		return err
	}
	if err := newDB.AutoMigrate(&Signer{}); err != nil {
		return err
	}
	if err := migrateAccountChainTypes(newDB); err != nil {
		return err
	}
	if err := newDB.AutoMigrate(&MigratedAccountData{}); err != nil {
		return err
	}

	db = newDB
	slog.Info("DB initialized")
	return nil
}

func migrateAccountChainTypes(database *gorm.DB) error {
	return database.Transaction(func(tx *gorm.DB) error {
		hadChainType := tx.Migrator().HasColumn(&Account{}, "chain_type")
		if err := tx.AutoMigrate(&Account{}); err != nil {
			return err
		}
		if hadChainType {
			return nil
		}
		// ponytail: one-time account scan; use batched migration for a large store.
		var accounts []Account
		if err := tx.Unscoped().Find(&accounts).Error; err != nil {
			return err
		}
		for _, account := range accounts {
			if isEd25519Address(account.Address) {
				if err := tx.Unscoped().Model(&Account{}).Where("id = ?", account.ID).Update("chain_type", "SVM").Error; err != nil {
					return err
				}
			}
		}
		return nil
	})
}

func isEd25519Address(address string) bool {
	if len(address) < 32 || len(address) > 44 {
		return false
	}
	const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
	var value big.Int
	for _, character := range address {
		digit := strings.IndexRune(alphabet, character)
		if digit < 0 {
			return false
		}
		value.Mul(&value, big.NewInt(58)).Add(&value, big.NewInt(int64(digit)))
	}
	return len(value.Bytes())+len(address)-len(strings.TrimLeft(address, "1")) == 32
}

// assertSharesAreBound fails when any stored share predates the device-bound
// ciphertext format. This release reads only bound shares, so booting against a
// legacy store would break wallet recovery for every affected user.
func assertSharesAreBound() error {
	var unbound int64
	err := db.Model(&Device{}).
		Where("share NOT LIKE ?", boundSharePrefix+"%").
		Count(&unbound).Error
	if err != nil {
		return fmt.Errorf("failed to check stored share format: %w", err)
	}
	if unbound > 0 {
		return fmt.Errorf(
			"%d stored share(s) are not in the bound %q format; this release cannot read them. "+
				"Re-register the affected devices on a fresh share store before deploying",
			unbound, boundSharePrefix,
		)
	}
	return nil
}
