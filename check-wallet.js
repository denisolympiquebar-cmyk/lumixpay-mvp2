const xrpl = require("xrpl");
const keypairs = require("ripple-keypairs");
const codec = require("ripple-address-codec");

// UBACI SVOJ TESTNET SEED
const seed = "sn6VB1baihsJsinKVzWRyX8c4DKY6";

const wallet = xrpl.Wallet.fromSeed(seed);
const keypair = keypairs.deriveKeypair(seed, { algorithm: "ed25519" });

console.log("=== FROM XRPL LIB ===");
console.log("Classic address:", wallet.classicAddress);
console.log("Public key:", wallet.publicKey);

console.log("\n=== FROM RIPPLE-KEYPAIRS ===");
console.log("Derived address:", keypairs.deriveAddress(keypair.publicKey));
console.log("Public key:", keypair.publicKey);

console.log("\n=== VALIDATION ===");
console.log("xrpl classicAddress valid:", codec.isValidClassicAddress(wallet.classicAddress));
console.log(
  "ripple-keypairs derived address valid:",
  codec.isValidClassicAddress(keypairs.deriveAddress(keypair.publicKey))
);
