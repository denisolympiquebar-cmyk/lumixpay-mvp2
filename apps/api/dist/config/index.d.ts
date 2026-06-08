export declare const config: {
    readonly port: number;
    readonly nodeEnv: string;
    readonly db: {
        readonly connectionString: string;
    };
    readonly jwt: {
        readonly secret: string;
        readonly expiresIn: string;
    };
    readonly refreshToken: {
        readonly enabled: boolean;
        readonly expiresIn: string;
    };
    readonly fee: {
        readonly rate: number;
    };
    readonly treasurySafety: {
        readonly depletionWarnRatio: number;
    };
    readonly xrplTestnetFaucetUrl: string;
    readonly xrplTestnetRpcUrl: string;
    readonly xrplAutoFundCustodialWallets: boolean;
    readonly xrplTestnetIssuerAddress: string;
    readonly xrplTestnetIssuerSeed: string;
    readonly xrplTestnetRlusdCurrency: string;
    readonly xrplTestnetEurqCurrency: string;
    readonly xrplTestnetTrustLimit: string;
    readonly xrplAutoSetupTrustLines: boolean;
    readonly xrplTestTokenDropEnabled: boolean;
    readonly xrplTestTokenDropRlusdAmount: string;
    readonly xrplTestTokenDropEurqAmount: string;
    readonly xrplTestTokenDropCooldownHours: number;
    readonly walletMasterKey: string;
    readonly walletEncryptionKeyId: string;
    readonly system: {
        readonly userId: "00000000-0000-0000-0001-000000000000";
        readonly accounts: {
            readonly rlusd: {
                readonly assetId: "00000000-0000-0000-0000-000000000001";
                readonly float: "00000000-0001-0000-0000-000000000001";
                readonly feeCollector: "00000000-0001-0000-0000-000000000002";
                readonly withdrawalEscrow: "00000000-0001-0000-0000-000000000003";
            };
            readonly eurq: {
                readonly assetId: "00000000-0000-0000-0000-000000000002";
                readonly float: "00000000-0002-0000-0000-000000000001";
                readonly feeCollector: "00000000-0002-0000-0000-000000000002";
                readonly withdrawalEscrow: "00000000-0002-0000-0000-000000000003";
            };
        };
    };
};
/** Throws at startup if production is configured with a default or missing JWT secret. */
export declare function assertProductionSecrets(): void;
export type Config = typeof config;
//# sourceMappingURL=index.d.ts.map