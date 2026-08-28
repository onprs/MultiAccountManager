export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

const exactMessages: Readonly<Record<string, string>> = {
  ORIGIN_REJECTED: "请求来源未通过安全校验，请刷新页面后重试",
  OWNER_SESSION_REQUIRED: "登录状态已失效，请重新登录",
  PASSKEY_REQUIRED: "请先使用通行密钥验证身份",
  PASSKEY_STEP_UP_REQUIRED: "请先使用通行密钥完成身份验证",
  SETUP_COMPLETE: "系统已经完成初始化",
  SETUP_SESSION_REQUIRED: "初始化会话已失效，请重新验证初始化令牌",
  SETUP_TOKEN_INVALID: "初始化令牌无效",
  SETUP_RATE_LIMITED: "尝试次数过多，请稍后再试",
  RUNTIME_CONFIG_INVALID: "运行时配置不可用，请检查配置主密钥和密钥文件权限",
  DATABASE_AUTHENTICATION_FAILED: "PostgreSQL 拒绝了当前用户名或密码",
  DATABASE_CONNECTION_FAILED: "无法连接 PostgreSQL，请检查地址、网络和 TLS 配置",
  DATABASE_NOT_FOUND: "指定的 PostgreSQL 数据库不存在",
  DATABASE_PERMISSION_DENIED: "数据库用户缺少创建或使用应用架构的权限",
  DATABASE_READ_ONLY: "当前 PostgreSQL 连接为只读，无法完成初始化",
  POOL_BUDGET_EXCEEDED: "Web 与后台任务连接池总和不能超过 80",
  POSTGRES_VERSION_UNSUPPORTED: "需要使用 PostgreSQL 14 或更高版本",
  SCHEMA_CONFLICT: "目标数据库架构包含不属于 Account Vault 的数据表",
  INITIALIZATION_ALREADY_STARTED: "系统初始化已经开始，请刷新页面查看当前状态",
  INITIALIZATION_IN_PROGRESS: "另一项初始化操作正在进行，请稍后重试",
  DATABASE_INITIALIZATION_REQUIRED: "请先完成数据库初始化",
  OWNER_EMAIL_CONFLICT: "管理员初始化已使用其他邮箱开始，请核对后重试",
  OWNER_SETUP_CLOSED: "管理员初始化已经关闭",
  OWNER_STATE_CONFLICT: "现有管理员数据与当前初始化状态不一致",
  DOMAIN_MIGRATION_NOT_PREPARED: "域名迁移尚未准备完成，暂时无法注册通行密钥",
  ACCOUNT_REVISION_CONFLICT: "账号已在其他位置更新，请刷新后重试",
  VAULT_REVISION_CONFLICT: "保险库已在其他位置更新，请刷新后重试",
  RECOVERY_CODE_REVISION_CONFLICT: "恢复码已在其他位置更新，请刷新后重试",
  VAULT_ALREADY_INITIALIZED: "保险库已经完成初始化",
  VAULT_OWNER_MISMATCH: "保险库所有者信息不匹配，请重新登录",
  LAST_PASSKEY_PROTECTED: "不能删除最后一个通行密钥",
  CONNECTION_CONFLICT: "同名 Sub2API 连接已经存在",
  LINK_CANDIDATE_NOT_FOUND: "待关联的本地或远端账号不存在",
  LINK_PLATFORM_MISMATCH: "本地账号与远端账号的平台不一致",
  LINK_CONFLICT: "该本地账号或远端账号已经建立关联",
  ALERT_NOT_ACKNOWLEDGEABLE: "该告警已不再处于待确认状态",
  OBSERVER_AUTH_REJECTED: "Sub2API 拒绝了当前集成令牌",
  OBSERVER_DELETE_FORBIDDEN: "Sub2API 集成令牌缺少删除权限",
  OBSERVER_SCHEMA_UNSUPPORTED: "Sub2API Observer 数据格式版本不受支持",
  SERVICE_KEY_ROTATION_PENDING: "仍有令牌等待使用当前服务密钥重新加密",
  SERVICE_KEY_UNAVAILABLE: "服务加密密钥暂时不可用",
  SUB2API_DELETE_CREDENTIAL_UNAVAILABLE: "Sub2API 删除凭据暂时不可用，本地账号已保留",
  SUB2API_DELETE_FAILED: "远端账号删除失败，本地账号已保留",
  CONNECTION_DISABLED: "连接已停用",
  INSTANCE_ID_CHANGED: "远端实例身份已发生变化，请核对连接地址",
  INSTANCE_ID_CHANGED_DURING_SYNC: "同步期间远端实例身份发生变化，请核对连接地址",
  INTEGRATION_SCOPE_INSUFFICIENT: "集成令牌缺少读取或删除权限",
  RESPONSE_TOO_LARGE: "远端响应超过允许大小",
  TIMEOUT: "远端请求超时，请稍后重试",
  CONNECTION_FAILED: "无法连接远端服务，请检查地址和网络",
  HTTPS_REQUIRED: "连接地址必须使用 HTTPS",
};

export function apiErrorMessage(
  failure: unknown,
  fallback = "请求失败，请稍后重试",
): string {
  const codeValue =
    typeof failure === "object" && failure !== null
      ? (failure as { code?: unknown }).code
      : undefined;
  const code = typeof codeValue === "string" ? codeValue : "";
  // 服务端 message 可能包含实现细节，用户界面只信任稳定错误码。
  if (Object.hasOwn(exactMessages, code)) {
    return exactMessages[code];
  }

  if (code.startsWith("INVALID_")) {
    return "提交的数据无效，请检查后重试";
  }
  if (code.endsWith("_NOT_FOUND")) {
    return "请求的内容不存在或已被删除";
  }
  if (code.endsWith("_CONFLICT")) {
    return "数据已发生变化，请刷新后重试";
  }
  if (code.endsWith("_UNAVAILABLE")) {
    return "服务暂时不可用，请稍后重试";
  }

  return fallback;
}

export function userErrorMessage(error: unknown, fallback: string): string {
  return error instanceof UserFacingError ? error.message : fallback;
}
