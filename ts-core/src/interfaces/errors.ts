/** HTTP（超文本传输协议） 状态码错误。 */
export type HttpStatusError<TStatusCode extends number> = Error & {
  /** HTTP（超文本传输协议） 状态码。 */
  readonly statusCode: TStatusCode;
};

/** 创建 HTTP 400（请求错误） 错误。 */
export function createHttpBadRequest(message: string): HttpStatusError<400> {
  return createHttpStatusError(message, 400);
}

/** 创建 HTTP 503（服务不可用） 错误。 */
export function createHttpServiceUnavailable(message: string): HttpStatusError<503> {
  return createHttpStatusError(message, 503);
}

function createHttpStatusError<TStatusCode extends number>(
  message: string,
  statusCode: TStatusCode,
): HttpStatusError<TStatusCode> {
  const error = new Error(message) as HttpStatusError<TStatusCode>;

  Object.defineProperty(error, "statusCode", {
    value: statusCode,
    enumerable: true,
    configurable: false,
    writable: false,
  });

  return error;
}
