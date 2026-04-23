/** Public XRPL Testnet JSON-RPC (for docs / UI; settlement is not enabled in MVP). */
export declare const XRPL_TESTNET_PUBLIC_JSON_RPC = "https://s.altnet.rippletest.net:51234";
export declare const XRPL_TESTNET_PUBLIC_WSS = "wss://s.altnet.rippletest.net/";
export declare const XRPL_PROFILE_NETWORK: "xrpl_testnet";
export declare function createWalletChallenge(userId: string): Promise<{
    challenge_id: string;
    message: string;
    expires_at: string;
    network: typeof XRPL_PROFILE_NETWORK;
    xrpl_testnet_json_rpc: string;
    xrpl_testnet_wss: string;
}>;
export declare function verifyAndLinkWallet(userId: string, input: {
    challenge_id: string;
    address: string;
    signature: string;
    public_key: string;
}): Promise<void>;
export declare function unlinkWallet(userId: string): Promise<void>;
//# sourceMappingURL=XrplWalletLinkService.d.ts.map