import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Moralis — unified multi-chain API for tokens, NFTs, prices, and more.
 * Uses the REST API directly (Moralis.start() blocks the Node.js event loop).
 *
 * Get a free API key: https://admin.moralis.io
 * Docs: https://docs.moralis.com
 */

const BASE_URL = 'https://deep-index.moralis.io/api/v2.2';

const EVM_CHAIN_IDS: Record<string, string> = {
  ethereum: '0x1',
  bnb:      '0x38',
  polygon:  '0x89',
};

@Injectable()
export class MoralisProvider implements OnModuleInit {
  private readonly logger = new Logger(MoralisProvider.name);

  chainId: string;
  apiKey: string;
  baseUrl = BASE_URL;

  private initialized = false;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    const network = this.configService.get<string>('NETWORK', 'ethereum');
    this.apiKey = this.configService.get<string>('MORALIS_API_KEY', '');
    this.chainId = EVM_CHAIN_IDS[network] || '';

    if (!this.apiKey) {
      this.logger.warn(
        'Moralis Provider: MORALIS_API_KEY is not set — token/NFT endpoints will not work. ' +
        'Get a free key at https://admin.moralis.io',
      );
      return;
    }

    this.initialized = true;
    this.logger.log(`Moralis Provider initialized (network: ${network})`);
  }

  isAvailable(): boolean {
    return this.initialized;
  }

  get headers(): Record<string, string> {
    return { 'X-API-Key': this.apiKey };
  }
}
