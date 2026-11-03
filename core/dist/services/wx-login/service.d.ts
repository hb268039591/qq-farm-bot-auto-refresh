export type ScanStatus = 'waiting' | 'scanned' | 'authorized' | 'cancelled' | 'expired';
export interface WxLoginSession {
    cookies: Map<string, string>;
    uuid: string;
    oauthCode?: string;
    openid?: string;
    nickname?: string;
    loginBuffer?: string;
    refreshtoken?: string;
    accesstoken?: string;
}
export declare class WxLoginService {
    createQrSession(): Promise<{
        session: WxLoginSession;
        qr: Buffer;
    }>;
    poll(session: WxLoginSession): Promise<ScanStatus>;
    confirm(session: WxLoginSession): Promise<{
        openid: string;
        loginBuffer: string;
    }>;
    issueCode(session: WxLoginSession, appId: string): Promise<string>;
    refreshLoginBuffer(session: Partial<WxLoginSession> & {
        cookies: Map<string, string>;
    }): Promise<{
        loginBuffer: string;
        refreshtoken: string;
        accesstoken: string;
    }>;
    destroy(session: WxLoginSession): void;
}
//# sourceMappingURL=service.d.ts.map