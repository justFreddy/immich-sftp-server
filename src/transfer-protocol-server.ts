export interface TransferProtocolServer {
  readonly name: string;
  start(): Promise<void>;
}
