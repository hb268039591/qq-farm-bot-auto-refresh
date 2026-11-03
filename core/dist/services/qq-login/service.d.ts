export {};
declare const QQ_MINIAPP_APP_ID = "1112386029";
export type QqLoginTaskStatus = 'waiting_scan' | 'scanned' | 'confirmed' | 'cancelled' | 'expired' | 'failed';
export interface QqLoginTask {
    taskId: string;
    status: QqLoginTaskStatus;
    qrImage: string;
    expiresAt: number;
}
export interface QqMiniappLoginResult {
    code: string;
    nickname?: string;
}
declare function createLoginTask(): Promise<QqLoginTask>;
declare function queryLoginStatus(taskId: string): Promise<QqLoginTask>;
declare function getMiniappCode(taskId: string): Promise<QqMiniappLoginResult>;
declare function cancelLoginTask(taskId: string): Promise<void>;
export { cancelLoginTask, createLoginTask, getMiniappCode, QQ_MINIAPP_APP_ID, queryLoginStatus, };
//# sourceMappingURL=service.d.ts.map