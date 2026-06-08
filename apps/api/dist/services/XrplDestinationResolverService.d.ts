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
export declare class XrplDestinationResolverService {
    /**
     * Resolves a withdrawal destination from either an XRPL classic address or a
     * LumixPay username (→ active custodial xrpl_testnet wallet).
     */
    resolveDestination(params: ResolveDestinationParams): Promise<ResolveDestinationResult>;
    private resolveFromUsername;
}
export declare const xrplDestinationResolverService: XrplDestinationResolverService;
//# sourceMappingURL=XrplDestinationResolverService.d.ts.map