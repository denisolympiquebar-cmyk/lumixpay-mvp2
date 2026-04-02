const keypairs = require("ripple-keypairs");

// 1. GENERATE WALLET
const seed = keypairs.generateSeed();
const keypair = keypairs.deriveKeypair(seed);
const address = keypairs.deriveAddress(keypair.publicKey);

console.log("=== XRPL TEST WALLET ===");
console.log("Seed:", seed);
console.log("Address:", address);
console.log("Public Key:", keypair.publicKey);
