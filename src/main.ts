import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { rpc } from '@stellar/stellar-sdk';
import { AppModule } from './app/app.module.js';
import { configureHttp } from './app/http-setup.js';
import { buildServices } from './app/services.js';
import { loadDeployments } from './chain/deployments.js';
import { loadEnv } from './config/env.js';
import { createPrisma } from './persistence/prisma-stores.js';
import { startFxRefresh, startIndexer, startKeeper, startMaintenance, startNotifier, startTtlKeeper } from './workers/runners.js';

/** Loads `.env` for local development (Node's built-in parser). Shell variables win; production injects env directly. */
function loadDotEnv(file = '.env'): void {
  if (process.env.NODE_ENV !== 'production' && existsSync(file)) process.loadEnvFile(file);
}

async function bootstrap(): Promise<void> {
  loadDotEnv();
  const env = loadEnv();
  const prisma = createPrisma(env.DATABASE_URL);
  const services = buildServices(env, prisma, loadDeployments(env.DEPLOYMENTS_FILE));

  if (env.ROLE === 'indexer' || env.INDEXER_EMBEDDED) {
    startIndexer(services, new rpc.Server(env.RPC_URL, { allowHttp: env.RPC_URL.startsWith('http://') }));
    console.log('indexer started');
  }
  if (env.ROLE === 'worker' || env.KEEPER_EMBEDDED) {
    startKeeper(services);
    startTtlKeeper(services);
    startMaintenance(services);
    startNotifier(services);
    startFxRefresh(services);
    console.log('keeper started');
  }
  if (env.ROLE !== 'api') return;

  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(services));
  configureHttp(app, env);
  await app.listen(env.PORT);
  console.log(`api listening on :${env.PORT}`);
}

void bootstrap();
