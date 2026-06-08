import { pool } from "../db/pool";

const XRPL_ADDRESS_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

export type ResolveDestinationResult = {
  destinationAddress: string;
  resolvedFrom: "address" | "username";
  destinationUserId?: string;
  destinationUsername?: string;
};

export type ResolveDestinationParams = {
  userId: string;
  destinationUsername?: string;
  destinationAddress?: string;
};

function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@+/, "");
}

function makeError(message: string, status: number, code?: string): Error & { status: number; code?: string } {
  return Object.assign(new Error(message), { status, code });
}

export class XrplDestinationResolverService {
  /**
   * Resolves a withdrawal destination from either an XRPL classic address or a
   * LumixPay username (→ active custodial xrpl_testnet wallet).
   */
  async resolveDestination(params: ResolveDestinationParams): Promise<ResolveDestinationResult> {
    const rawUsername = params.destinationUsername?.trim() ?? "";
    const rawAddress  = params.destinationAddress?.trim() ?? "";
    const hasUsername = rawUsername.length > 0;
    const hasAddress  = rawAddress.length > 0;

    if (!hasUsername && !hasAddress) {
      throw makeError(
        "Provide either xrpl_destination_address or destination_username.",
        400,
        "MISSING_DESTINATION"
      );
    }

    if (hasUsername && hasAddress) {
      const fromUsername = await this.resolveFromUsername(params.userId, rawUsername);
      if (fromUsername.destinationAddress !== rawAddress) {
        throw makeError(
          "destination_username and xrpl_destination_address do not match the same wallet.",
          400,
          "DESTINATION_MISMATCH"
        );
      }
      return fromUsername;
    }

    if (hasUsername) {
      return this.resolveFromUsername(params.userId, rawUsername);
    }

    if (!XRPL_ADDRESS_RE.test(rawAddress)) {
      throw makeError("Invalid XRPL address", 400, "INVALID_XRPL_ADDRESS");
    }

    return {
      destinationAddress: rawAddress,
      resolvedFrom: "address",
    };
  }

  private async resolveFromUsername(
    requesterUserId: string,
    rawUsername: string
  ): Promise<ResolveDestinationResult> {
    const username = normalizeUsername(rawUsername);
    if (!username) {
      throw makeError(
        "Provide either xrpl_destination_address or destination_username.",
        400,
        "MISSING_DESTINATION"
      );
    }

    const { rows } = await pool.query<{
      user_id: string;
      username: string;
      classic_address: string;
    }>(
      `SELECT u.id AS user_id, u.username, uw.classic_address
         FROM users u
         JOIN user_wallets uw ON uw.user_id = u.id
        WHERE LOWER(u.username) = LOWER($1)
          AND u.role != 'system'
          AND uw.network = 'xrpl_testnet'
          AND uw.wallet_type = 'custodial'
          AND uw.is_active = true
        ORDER BY uw.created_at DESC
        LIMIT 1`,
      [username]
    );

    const row = rows[0];
    if (!row) {
      throw makeError(
        "Recipient username not found or does not have an active XRPL Testnet wallet.",
        404,
        "DESTINATION_NOT_FOUND"
      );
    }

    if (row.user_id === requesterUserId) {
      throw makeError(
        "You cannot withdraw to your own LumixPay XRPL wallet by username.",
        400,
        "SELF_WITHDRAWAL_USERNAME"
      );
    }

    return {
      destinationAddress: row.classic_address,
      resolvedFrom: "username",
      destinationUserId: row.user_id,
      destinationUsername: row.username,
    };
  }
}

export const xrplDestinationResolverService = new XrplDestinationResolverService();
