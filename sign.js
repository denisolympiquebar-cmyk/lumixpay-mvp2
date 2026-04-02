const keypairs = require("ripple-keypairs");

const seed = "sn6VB1baihsJsinKVzWRyX8c4DKY6";

const message = `LumixPay — link XRPL Testnet wallet to this LumixPay account
User ID: d0bb462b-1095-48a2-9590-df65eba3adb3
Email: denisolympiquebar@gmail.com
Nonce: a7a421f5-64df-42d4-826f-17816daf901c
Expires (UTC): 2026-04-02T09:25:58.367Z

Network: XRPL Testnet only.

Sign the exact UTF-8 text of this message with your XRPL account key.
Use ripple-keypairs (or a compatible wallet) so the signature matches this message.`;

const keypair = keypairs.deriveKeypair(seed, { algorithm: "ed25519" });
const messageHex = Buffer.from(message, "utf8").toString("hex");
const signature = keypairs.sign(messageHex, keypair.privateKey);

console.log("Address:", keypairs.deriveAddress(keypair.publicKey));
console.log("Public Key:", keypair.publicKey);
console.log("Signature:", signature);
