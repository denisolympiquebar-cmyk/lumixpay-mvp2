import crypto from "crypto";
import { isValidClassicAddress } from "ripple-address-codec";
import { deriveAddress, verify } from "ripple-keypairs";
import { pool } from "../db/pool";

/** Public XRPL Testnet JSON-RPC (for docs / UI; settlement is not enabled in MVP). */
export const XRPL_TESTNET_PUBLIC_JSON_RPC = "https://s.altnet.rippletest.net:51234";
export const XRPL_TESTNET_PUBLIC_WSS = "wss://s.altnet.rippletest.net/";

export const XRPL_PROFILE_NETWORK = "xrpl_testnet" as const;

const CHALLENGE_TTL_MS = 15 * 60 * 1000;

function normalizeHex(s: string): string {
  let x = s.trim().replace(/^0x/i, "");
  x = x.replace(/\s+/g, "");
  return x.toUpperCase();
}

function buildMessage(params: {
  userId: string;
  email: string;
  nonce: string;
  expiresIso: string;
}): string {
  return [
    "LumixPay — link XRPL Testnet wallet to this LumixPay account",
    `User ID: ${params.userId}`,
    `Email: ${params.email}`,
    `Nonce: ${params.nonce}`,
    `Expires (UTC): ${params.expiresIso}`,
    "",
    "Network: XRPL Testnet only.",
    "",
    "Sign the exact UTF-8 text of this message with your XRPL account key.",
    "Use ripple-keypairs (or a compatible wallet) so the signature matches this message.",
  ].join("\n");
}

export async function createWalletChallenge(userId: string): Promise<{
  challenge_id: string;
  message: string;
  expires_at: string;
  network: typeof XRPL_PROFILE_NETWORK;
  xrpl_testnet_json_rpc: string;
  xrpl_testnet_wss: string;
}> {
  const { rows: userRows } = await pool.query<{ email: string }>(
    "SELECT email FROM users WHERE id = $1 AND role != 'system'",
    [userId]
  );
  if (!userRows[0]) throw new Error("USER_NOT_FOUND");

  const nonce = crypto.randomUUID();
  const expires = new Date(Date.now() + CHALLENGE_TTL_MS);
  const expiresIso = expires.toISOString();
  const message = buildMessage({
    userId,
    email: userRows[0].email,
    nonce,
    expiresIso,
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM wallet_link_challenges WHERE expires_at < NOW()");
    await client.query("DELETE FROM wallet_link_challenges WHERE user_id = $1", [userId]);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO wallet_link_challenges (user_id, message, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [userId, message, expires]
    );
    await client.query("COMMIT");
    const id = rows[0]!.id;
    return {
      challenge_id: id,
      message,
      expires_at: expiresIso,
      network: XRPL_PROFILE_NETWORK,
      xrpl_testnet_json_rpc: XRPL_TESTNET_PUBLIC_JSON_RPC,
      xrpl_testnet_wss: XRPL_TESTNET_PUBLIC_WSS,
    };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
}

function messageToHex(message: string): string {
  return Buffer.from(message, "utf8").toString("hex").toUpperCase();
}

export async function verifyAndLinkWallet(
  userId: string,
  input: {
    challenge_id: string;
    address: string;
    signature: string;
    public_key: string;
  }
): Promise<void> {
  const address = input.address.trim();
  if (!isValidClassicAddress(address)) {
    const err = new Error("XRPL_ADDRESS_INVALID");
    (err as any).code = "XRPL_ADDRESS_INVALID";
    throw err;
  }

  const publicKey = normalizeHex(input.public_key);

  const signature = normalizeHex(input.signature);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: chRows } = await client.query<{
      message: string;
      expires_at: Date;
      user_id: string;
    }>(
      `SELECT message, expires_at, user_id FROM wallet_link_challenges WHERE id = $1 FOR UPDATE`,
      [input.challenge_id]
    );
    const ch = chRows[0];
    if (!ch || ch.user_id !== userId) {
      const err = new Error("WALLET_CHALLENGE_INVALID");
      (err as any).code = "WALLET_CHALLENGE_INVALID";
      throw err;
    }
    if (new Date(ch.expires_at) < new Date()) {
      const err = new Error("WALLET_CHALLENGE_EXPIRED");
      (err as any).code = "WALLET_CHALLENGE_EXPIRED";
      throw err;
    }

    let derived: string;
    try {
      derived = deriveAddress(publicKey);
    } catch {
      const err = new Error("XRPL_PUBLIC_KEY_INVALID");
      (err as any).code = "XRPL_PUBLIC_KEY_INVALID";
      throw err;
    }
    if (derived !== address) {
      const err = new Error("XRPL_ADDRESS_KEY_MISMATCH");
      (err as any).code = "XRPL_ADDRESS_KEY_MISMATCH";
      throw err;
    }

    const messageHex = messageToHex(ch.message);
    let ok = false;
    try {
      ok = verify(messageHex, signature, publicKey);
    } catch {
      ok = false;
    }
    if (!ok) {
      const err = new Error("XRPL_SIGNATURE_INVALID");
      (err as any).code = "XRPL_SIGNATURE_INVALID";
      throw err;
    }

    const { rows: conflict } = await client.query<{ id: string }>(
      "SELECT id FROM users WHERE xrpl_address = $1 AND id != $2",
      [address, userId]
    );
    if (conflict.length > 0) {
      const err = new Error("XRPL_ADDRESS_ALREADY_LINKED");
      (err as any).code = "XRPL_ADDRESS_ALREADY_LINKED";
      throw err;
    }

    await client.query(
      `UPDATE users SET
         xrpl_address = $1,
         xrpl_network = $2,
         xrpl_verified_at = NOW()
       WHERE id = $3`,
      [address, XRPL_PROFILE_NETWORK, userId]
    );

    await client.query("DELETE FROM wallet_link_challenges WHERE id = $1", [input.challenge_id]);

    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
}

export async function unlinkWallet(userId: string): Promise<void> {
  await pool.query(
    `UPDATE users SET xrpl_address = NULL, xrpl_network = NULL, xrpl_verified_at = NULL
     WHERE id = $1`,
    [userId]
  );
  await pool.query("DELETE FROM wallet_link_challenges WHERE user_id = $1", [userId]);
}
