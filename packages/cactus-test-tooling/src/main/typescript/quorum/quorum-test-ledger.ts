import { Stream } from "stream";
import { EventEmitter } from "events";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import Docker, { Container, ContainerInfo } from "dockerode";
import Joi from "joi";
import tar from "tar-stream";
import Web3 from "web3";
import { Account } from "web3-core";
import {
  Bools,
  Logger,
  LoggerProvider,
  LogLevelDesc,
} from "@hyperledger/cactus-common";
import { ITestLedger } from "../i-test-ledger";
import { Streams } from "../common/streams";
import { IKeyPair } from "../i-key-pair";
import { IQuorumGenesisOptions } from "./i-quorum-genesis-options";
import { Containers } from "../common/containers";

export interface IQuorumTestLedgerConstructorOptions {
  containerImageVersion?: string;
  containerImageName?: string;
  rpcApiHttpPort?: number;
  rpcApiWsPort?: number;
  logLevel?: LogLevelDesc;
  emitContainerLogs?: boolean;
  readonly envVars?: string[];
}

export const QUORUM_TEST_LEDGER_DEFAULT_OPTIONS = Object.freeze({
  containerImageVersion: "2021-01-08-7a055c3",
  containerImageName: "ghcr.io/hyperledger/cactus-quorum-all-in-one",
  rpcApiHttpPort: 8545,
  rpcApiWsPort: 8546,
});

export const QUORUM_TEST_LEDGER_OPTIONS_JOI_SCHEMA: Joi.Schema =
  Joi.object().keys({
    containerImageVersion: Joi.string().min(5).required(),
    containerImageName: Joi.string().min(1).required(),
    rpcApiHttpPort: Joi.number()
      .integer()
      .positive()
      .min(1024)
      .max(65535)
      .required(),
  });

export class QuorumTestLedger implements ITestLedger {
  public readonly containerImageVersion: string;
  public readonly containerImageName: string;
  public readonly rpcApiHttpPort: number;
  public readonly rpcApiWsPort: number;
  public readonly emitContainerLogs: boolean;

  private readonly log: Logger;
  private container: Container | undefined;
  private containerId: string | undefined;
  private readonly envVars: string[];

  constructor(
    public readonly options: IQuorumTestLedgerConstructorOptions = {},
  ) {
    if (!options) {
      throw new TypeError(`QuorumTestLedger#ctor options was falsy.`);
    }
    this.containerImageVersion =
      options.containerImageVersion ||
      QUORUM_TEST_LEDGER_DEFAULT_OPTIONS.containerImageVersion;
    this.containerImageName =
      options.containerImageName ||
      QUORUM_TEST_LEDGER_DEFAULT_OPTIONS.containerImageName;
    this.rpcApiHttpPort =
      options.rpcApiHttpPort ||
      QUORUM_TEST_LEDGER_DEFAULT_OPTIONS.rpcApiHttpPort;
    this.rpcApiWsPort =
      options.rpcApiWsPort || QUORUM_TEST_LEDGER_DEFAULT_OPTIONS.rpcApiWsPort;

    this.envVars = options.envVars || [];

    this.emitContainerLogs = Bools.isBooleanStrict(options.emitContainerLogs)
      ? (options.emitContainerLogs as boolean)
      : true;

    this.validateConstructorOptions();

    const label = "quorum-test-ledger";
    const level = options.logLevel || "INFO";
    this.log = LoggerProvider.getOrCreate({ level, label });
  }

  public getContainer(): Container {
    const fnTag = "QuorumTestLedger#getQuorumKeyPair()";
    if (!this.container) {
      throw new Error(`${fnTag} container not started by this instance yet.`);
    } else {
      return this.container;
    }
  }

  public getContainerImageName(): string {
    return `${this.containerImageName}:${this.containerImageVersion}`;
  }

  public async getRpcApiHttpHost(): Promise<string> {
    const ipAddress = "127.0.0.1";
    const hostPort = await this.getRpcHttpApiPublicPort();
    return `http://${ipAddress}:${hostPort}`;
  }
  public async getRpcApiWsHost(): Promise<string> {
    const ipAddress = "127.0.0.1";
    const hostPort = await this.getRpcWsApiPublicPort();
    return `ws://${ipAddress}:${hostPort}`;
  }

  public async getFileContents(filePath: string): Promise<string> {
    const response: NodeJS.ReadableStream =
      await this.getContainer().getArchive({
        path: filePath,
      });
    const extract: tar.Extract = tar.extract({ autoDestroy: true });

    return new Promise((resolve, reject) => {
      let fileContents = "";
      extract.on("entry", async (header: unknown, stream, next) => {
        stream.on("error", (err: Error) => {
          reject(err);
        });
        const chunks: string[] = await Streams.aggregate<string>(stream);
        fileContents += chunks.join("");
        stream.resume();
        next();
      });

      extract.on("finish", () => {
        resolve(fileContents);
      });

      response.pipe(extract);
    });
  }

  /**
   * Obtains the address of an account from the genesis allocation with a
   * minimum balance of `minBalance`.
   *
   * @param minBalance The minimum balance to try and find a genesis account with.
   *
   * @throws {Error} If the balance is too high and there aren't any genesis
   * accounts allocated with such a high balance then an exception is thrown.
   */
  public async getGenesisAccount(minBalance = 10e7): Promise<string> {
    const { alloc } = await this.getGenesisJsObject();

    const firstHighNetWorthAccount = Object.keys(alloc).find(
      (addr) => parseInt(alloc[addr].balance, 10) > minBalance,
    ) as string;

    return firstHighNetWorthAccount;
  }

  /**
   * Creates a new ETH account from scratch on the ledger and then sends it a
   * little seed money to get things started.
   *
   * @param [seedMoney=10e8] The amount of money to seed the new test account with.
   */
  public async createEthTestAccount(seedMoney = 10e8): Promise<Account> {
    const rpcApiHttpHost = await this.getRpcApiHttpHost();
    const web3 = new Web3(rpcApiHttpHost);
    const ethTestAccount = web3.eth.accounts.create(uuidv4());

    const genesisAccount = await this.getGenesisAccount();

    await web3.eth.personal.sendTransaction(
      {
        from: genesisAccount,
        to: ethTestAccount.address,
        value: seedMoney,
      },
      "",
    );

    return ethTestAccount;
  }

  public async getQuorumKeyPair(): Promise<IKeyPair> {
    const publicKey = await this.getFileContents("/nodekey");
    const privateKey = await this.getFileContents("/key");
    return { publicKey, privateKey };
  }

  public async getGenesisJsObject(): Promise<IQuorumGenesisOptions> {
    const quorumGenesisJson: string =
      await this.getFileContents("/genesis.json");
    return JSON.parse(quorumGenesisJson);
  }

  public async getTesseraKeyPair(): Promise<IKeyPair> {
    const publicKey = await this.getFileContents("/tm.pub");
    const privateKey = await this.getFileContents("/tm.key");
    return { publicKey, privateKey };
  }

  public async start(omitPull = false): Promise<Container> {
    const containerNameAndTag = this.getContainerImageName();

    this.log.debug(`Starting Quorum Test Ledger: ${containerNameAndTag}`);
    if (this.container) {
      await this.container.stop();
      await this.container.remove();
    }
    const docker = new Docker();

    if (!omitPull) {
      this.log.debug(`Pulling image: ${containerNameAndTag}`);
      await this.pullContainerImage(containerNameAndTag);
    }

    return new Promise<Container>((resolve, reject) => {
      const eventEmitter: EventEmitter = docker.run(
        containerNameAndTag,
        [],
        [],
        {
          Env: this.envVars,
          ExposedPorts: {
            [`${this.rpcApiHttpPort}/tcp`]: {}, // quorum RPC - HTTP
            [`${this.rpcApiWsPort}/tcp`]: {}, // quorum RPC - WebSocket
            "8888/tcp": {}, // orion Client Port - HTTP
            "8080/tcp": {}, // orion Node Port - HTTP
            "9001/tcp": {}, // supervisord - HTTP
            "9545/tcp": {}, // quorum metrics
          },
          // This is a workaround needed for macOS which has issues with routing
          // to docker container's IP addresses directly...
          // https://stackoverflow.com/a/39217691
          PublishAllPorts: true,
        },
        {},
        (err: unknown) => {
          if (err) {
            reject(err);
          }
        },
      );

      eventEmitter.once("start", async (container: Container) => {
        this.container = container;
        this.containerId = container.id;

        this.log.debug("Quorum Test Ledger container started booting OK.");

        if (this.emitContainerLogs) {
          const fnTag = `[${this.getContainerImageName()}]`;
          await Containers.streamLogs({
            container: this.container,
            tag: fnTag,
            log: this.log,
          });
        }

        try {
          await this.waitForHealthCheck();
          this.log.debug("Quorum Test Ledger container passed healthcheck OK");
          resolve(container);
        } catch (ex) {
          reject(ex);
        }
      });
    });
  }

  public async waitForHealthCheck(timeoutMs = 120000): Promise<void> {
    const fnTag = "QuorumTestLedger#waitForHealthCheck()";
    const httpUrl = await this.getRpcApiHttpHost();
    const startedAt = Date.now();
    let reachable = false;
    do {
      try {
        const res = await axios.get(httpUrl);
        reachable = res.status > 199 && res.status < 300;
      } catch (ex: unknown) {
        if (ex instanceof Error) {
          reachable = false;
          if (Date.now() >= startedAt + timeoutMs) {
            throw new Error(
              `${fnTag} timed out (${timeoutMs}ms) -> ${ex.stack}`,
            );
          }
        }
      }
      await new Promise((resolve2) => setTimeout(resolve2, 100));
    } while (!reachable);
  }

  public stop(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.container) {
        this.container.stop({}, (err: unknown, result: unknown) => {
          if (err) {
            reject(err);
          } else {
            resolve(result);
          }
        });
      } else {
        return reject(
          new Error(
            `QuorumTestLedger#stop() Container was not running to begin with.`,
          ),
        );
      }
    });
  }

  public destroy(): Promise<unknown> {
    if (this.container) {
      return this.container.remove();
    } else {
      return Promise.reject(
        new Error(
          `QuorumTestLedger#destroy() Container was never created, nothing to destroy.`,
        ),
      );
    }
  }

  protected async getContainerInfo(): Promise<ContainerInfo> {
    const fnTag = "QuorumTestLedger#getContainerInfo()";
    const docker = new Docker();
    const image = this.getContainerImageName();
    const containerInfos = await docker.listContainers({});

    let aContainerInfo;
    if (this.containerId !== undefined) {
      aContainerInfo = containerInfos.find((ci) => ci.Id === this.containerId);
    }

    if (aContainerInfo) {
      return aContainerInfo;
    } else {
      throw new Error(`${fnTag} no image found: "${image}"`);
    }
  }

  public async getRpcHttpApiPublicPort(): Promise<number> {
    const fnTag = "QuorumTestLedger#getRpcApiPublicPort()";
    const aContainerInfo = await this.getContainerInfo();
    const { rpcApiHttpPort: thePort } = this;
    const { Ports: ports } = aContainerInfo;

    if (ports.length < 1) {
      throw new Error(`${fnTag} no ports exposed or mapped at all`);
    }
    const mapping = ports.find((x) => x.PrivatePort === thePort);
    if (mapping) {
      if (!mapping.PublicPort) {
        throw new Error(`${fnTag} port ${thePort} mapped but not public`);
      } else if (mapping.IP !== "0.0.0.0") {
        throw new Error(`${fnTag} port ${thePort} mapped to 127.0.0.1`);
      } else {
        return mapping.PublicPort;
      }
    } else {
      throw new Error(`${fnTag} no mapping found for ${thePort}`);
    }
  }

  public async getRpcWsApiPublicPort(): Promise<number> {
    const fnTag = "QuorumTestLedger#getRpcWsApiPublicPort()";
    const aContainerInfo = await this.getContainerInfo();
    const { rpcApiWsPort: thePort } = this;
    const { Ports: ports } = aContainerInfo;

    if (ports.length < 1) {
      throw new Error(`${fnTag} no ports exposed or mapped at all`);
    }
    const mapping = ports.find((x) => x.PrivatePort === thePort);
    if (mapping) {
      if (!mapping.PublicPort) {
        throw new Error(`${fnTag} port ${thePort} mapped but not public`);
      } else if (mapping.IP !== "0.0.0.0") {
        throw new Error(`${fnTag} port ${thePort} mapped to 127.0.0.1`);
      } else {
        return mapping.PublicPort;
      }
    } else {
      throw new Error(`${fnTag} no mapping found for ${thePort}`);
    }
  }

  public async getContainerIpAddress(): Promise<string> {
    const fnTag = "QuorumTestLedger#getContainerIpAddress()";
    const aContainerInfo = await this.getContainerInfo();

    if (aContainerInfo) {
      const { NetworkSettings } = aContainerInfo;
      const networkNames: string[] = Object.keys(NetworkSettings.Networks);
      if (networkNames.length < 1) {
        throw new Error(`${fnTag} container not connected to any network`);
      } else {
        // return IP address of container on the first network that we found it connected to. Make this configurable?
        return NetworkSettings.Networks[networkNames[0]].IPAddress;
      }
    } else {
      throw new Error(
        `QuorumTestLedger#getContainerIpAddress() cannot find container image ${this.containerImageName}`,
      );
    }
  }

  private pullContainerImage(containerNameAndTag: string): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      const docker = new Docker();
      docker.pull(containerNameAndTag, (pullError: unknown, stream: Stream) => {
        if (pullError) {
          reject(pullError);
        } else {
          docker.modem.followProgress(
            stream,
            (progressError: unknown, output: unknown[]) => {
              if (progressError) {
                reject(progressError);
              } else {
                resolve(output);
              }
            },
          );
        }
      });
    });
  }

  private validateConstructorOptions(): void {
    const validationResult = QUORUM_TEST_LEDGER_OPTIONS_JOI_SCHEMA.validate({
      containerImageVersion: this.containerImageVersion,
      containerImageName: this.containerImageName,
      rpcApiHttpPort: this.rpcApiHttpPort,
    });

    if (validationResult.error) {
      throw new Error(
        `QuorumTestLedger#ctor ${validationResult.error.annotate()}`,
      );
    }
  }
}
