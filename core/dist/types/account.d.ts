export {};
export interface Account {
    id: string;
    name: string;
    code: string;
    platform: string;
    uin: string;
    qq: string;
    avatar: string;
    nick?: string;
    wxid?: string;
    loginBuffer?: string;
    refreshtoken?: string;
    accesstoken?: string;
    createdAt: number;
    updatedAt: number;
}
export interface AccountsData {
    accounts: Account[];
    nextId: number;
}
//# sourceMappingURL=account.d.ts.map