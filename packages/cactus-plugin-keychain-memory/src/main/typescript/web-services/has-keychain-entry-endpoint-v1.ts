import type { Express, Request, Response } from "express";

import {
  Logger,
  Checks,
  LogLevelDesc,
  LoggerProvider,
  IAsyncProvider,
} from "@hyperledger/cactus-common";
import {
  IEndpointAuthzOptions,
  IExpressRequestHandler,
  IWebServiceEndpoint,
} from "@hyperledger/cactus-core-api";
import {
  handleRestEndpointException,
  registerWebServiceEndpoint,
} from "@hyperledger/cactus-core";

import OAS from "../../json/openapi.json";
import { PluginKeychainMemory } from "../plugin-keychain-memory";
import { HasKeychainEntryRequestV1 } from "@hyperledger/cactus-core-api";

export interface IHasKeychainEntryEndpointOptions {
  logLevel?: LogLevelDesc;
  plugin: PluginKeychainMemory;
}

export class HasKeychainEntryV1Endpoint implements IWebServiceEndpoint {
  public static readonly CLASS_NAME = "HasKeychainEntryV1Endpoint";

  private readonly log: Logger;

  public get className(): string {
    return HasKeychainEntryV1Endpoint.CLASS_NAME;
  }

  constructor(public readonly options: IHasKeychainEntryEndpointOptions) {
    const fnTag = `${this.className}#constructor()`;
    Checks.truthy(options, `${fnTag} arg options`);
    Checks.truthy(options.plugin, `${fnTag} arg options.connector`);

    const level = this.options.logLevel || "INFO";
    const label = this.className;
    this.log = LoggerProvider.getOrCreate({ level, label });
  }

  public getOasPath(): (typeof OAS.paths)["/api/v1/plugins/@hyperledger/cactus-plugin-keychain-memory/has-keychain-entry"] {
    return OAS.paths[
      "/api/v1/plugins/@hyperledger/cactus-plugin-keychain-memory/has-keychain-entry"
    ];
  }

  public getPath(): string {
    const apiPath = this.getOasPath();
    return apiPath.post["x-hyperledger-cacti"].http.path;
  }

  public getVerbLowerCase(): string {
    const apiPath = this.getOasPath();
    return apiPath.post["x-hyperledger-cacti"].http.verbLowerCase;
  }

  public getOperationId(): string {
    return this.getOasPath().post.operationId;
  }

  getAuthorizationOptionsProvider(): IAsyncProvider<IEndpointAuthzOptions> {
    // TODO: make this an injectable dependency in the constructor
    return {
      get: async () => ({
        isProtected: true,
        requiredRoles: [],
      }),
    };
  }

  public async registerExpress(
    expressApp: Express,
  ): Promise<IWebServiceEndpoint> {
    await registerWebServiceEndpoint(expressApp, this);
    return this;
  }

  public getExpressRequestHandler(): IExpressRequestHandler {
    return this.handleRequest.bind(this);
  }

  public async handleRequest(req: Request, res: Response): Promise<void> {
    const fnTag = `${this.className}#handleRequest()`;
    const reqTag = `${this.getVerbLowerCase()} - ${this.getPath()}`;
    this.log.debug(reqTag);
    try {
      const reqBody = req.body as HasKeychainEntryRequestV1;
      const { key } = reqBody;
      const checkedAt = new Date().toJSON();
      const isPresent = await this.options.plugin.has(key);
      const resBody = {
        isPresent,
        key,
        checkedAt,
      };
      res.json(resBody);
    } catch (ex) {
      const errorMsg = `${reqTag} ${fnTag} Failed to deploy contract:`;
      handleRestEndpointException({ errorMsg, log: this.log, error: ex, res });
    }
  }
}
