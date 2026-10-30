const AUTHENTICATION_ERROR_PATTERN =
  /AUTH_FAILED|AUTH_REJECT|authentication.*fail|invalid.*(credential|password)|认证失败|身份验证失败/i;

export function isAuthenticationError(message: string): boolean {
  return AUTHENTICATION_ERROR_PATTERN.test(message);
}

export function localizeConnectionError(message: string, authenticationFailed: string): string {
  return isAuthenticationError(message) ? authenticationFailed : message;
}
