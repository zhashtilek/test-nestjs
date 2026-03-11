import { Injectable, BadRequestException } from '@nestjs/common';
import axios from 'axios';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisService } from '../redis/redis.service';
import { EvmProvider } from '../blockchain/providers/evm.provider';
import { SolanaProvider } from '../blockchain/providers/solana.provider';
import { Web3Provider } from '../blockchain/providers/web3.provider';
import { TonProvider } from '../blockchain/providers/ton.provider';
import { MoralisProvider } from '../blockchain/providers/moralis.provider';
import { MetaplexProvider } from '../blockchain/providers/metaplex.provider';
import { WatchWalletDto } from './dto/watch-wallet.dto';
import {
  WalletBalance,
  Transaction,
  TransactionList,
  WatchedWallet,
  WatchedWalletWithBalance,
  BalanceAlert,
  TokenBalance,
  NftItem,
} from '../blockchain/types/blockchain.types';
import {
  WALLET_BALANCE_CHANGED,
  WalletBalanceChangedEvent,
} from './events/wallet-balance-changed.event';
import { formatBalance, hasBalanceChanged } from '../utils/decimal.utils';

const CACHE_KEYS = {
  balance: (address: string) => `balance:${address}`,
  transactions: (address: string, limit: number) => `txs:${address}:${limit}`,
  tokens: (address: string) => `tokens:${address}`,
  nfts: (address: string) => `nfts:${address}`,
  lastBalance: (address: string) => `last_balance:${address}`,
  watchlist: 'watchlist',
  alerts: 'wallet:alerts',
};

const CACHE_TTL = {
  balance: 30,      // seconds
  transactions: 60, // seconds
  tokens: 120,      // seconds
  nfts: 300,        // seconds
};

interface MoralisTokenResponse {
  token_address: string;
  name: string;
  symbol: string;
  decimals: number;
  balance: string;
  balance_formatted: string;
}

interface MoralisNftResponse {
  token_address: string;
  token_id: string;
  name: string;
  symbol: string;
}

interface EtherscanV2Transaction {
  hash: string;
  from: string;
  to: string;
  value: string;
  timeStamp: string;
  txreceipt_status?: string;
  isError?: string;
}

interface EtherscanV2Response {
  status?: string;
  message?: string;
  result?: EtherscanV2Transaction[] | string;
}

/**
 * Service for wallet operations: balance, transactions, tokens, NFTs, watchlist and alerts.
 * Uses Redis for caching and storage; EVM (Etherscan, Moralis) for data fetching.
 */
@Injectable()
export class WalletService {
  private readonly network: string;

  constructor(
    private readonly redis: RedisService,
    private readonly evm: EvmProvider,
    private readonly sol: SolanaProvider,
    private readonly web3: Web3Provider,
    private readonly ton: TonProvider,
    private readonly moralis: MoralisProvider,
    private readonly metaplex: MetaplexProvider,
    private readonly configService: ConfigService,
    private readonly events: EventEmitter2,
  ) {
    this.network = this.configService.get<string>('NETWORK', 'ethereum');
  }

  /**
   * Returns native token balance for a wallet address.
   * Uses Redis cache (TTL 30s); on miss fetches via EVM provider and caches the result.
   * @param address - EVM (0x...), Solana (base58), or TON address
   * @returns WalletBalance with balance, symbol, network and cached flag
   * @throws BadRequestException when provider fails or address is invalid
   */
  async getBalance(address: string): Promise<WalletBalance> {
    const key = CACHE_KEYS.balance(address);
    const cached = await this.redis.get(key);
    if (cached) {
      const parsed = JSON.parse(cached) as WalletBalance;
      return { ...parsed, cached: true };
    }

    try {
      const rawBalance = await this.evm.provider.getBalance(address);
      const balance = formatBalance(rawBalance, this.evm.config.decimals);
      const value = { address, balance, symbol: this.evm.config.symbol, network: this.network };
      await this.redis.set(key, JSON.stringify(value), CACHE_TTL.balance);
      return { ...value, cached: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Request failed';
      throw new BadRequestException(message);
    }
  }

  /**
   * Returns recent transactions for a wallet address.
   * Uses Redis cache (TTL 60s); on miss fetches via Etherscan-like API and maps to Transaction[].
   * @param address - Wallet address (EVM 0x...)
   * @param limit - Max number of transactions (default 10)
   * @returns TransactionList with transactions, address, network and cached flag
   * @throws BadRequestException when fetch fails
   */
  async getTransactions(address: string, limit = 10): Promise<TransactionList> {
    const key = CACHE_KEYS.transactions(address, limit);
    const cached = await this.redis.get(key);

    if (cached) {
      const parsed = JSON.parse(cached) as TransactionList;
      return { ...parsed, cached: true };
    }

    try {
      const explorerTransactions = await this.fetchEvmTransactions(address, limit);
      const transactions = explorerTransactions.map((tx) => this.mapEvmTransaction(tx));
      const value = {
        address,
        transactions,
        network: this.network,
      };
      await this.redis.set(key, JSON.stringify(value), CACHE_TTL.transactions);
      return { ...value, cached: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Request failed';
      throw new BadRequestException(message);
    }
  }

  /**
   * Adds a wallet to the watchlist (Redis hash). Address is stored lowercased.
   * @param dto - address and optional label
   * @returns { success: true, address } with normalized address
   */
  async watchWallet(dto: WatchWalletDto): Promise<{ success: boolean; address: string }> {
    const address = dto.address.toLowerCase();

    await this.redis.hset(
      CACHE_KEYS.watchlist,
      address,
      JSON.stringify({
        address,
        label: dto.label ?? '',
        addedAt: Date.now(),
      }),
    );

    return { success: true, address };
  }

  /**
   * Returns all watched wallets with current balances.
   * For each wallet: loads previous balance from Redis, fetches current via getBalance,
   * emits WALLET_BALANCE_CHANGED if balance changed, then stores current as lastBalance.
   * @returns WatchedWalletWithBalance[] (address, label, addedAt, balance, symbol)
   */
  async getWatchedWallets(): Promise<WatchedWalletWithBalance[]> {
    const all = await this.redis.hgetall(CACHE_KEYS.watchlist);
    const entries = Object.values(all).map((v) => JSON.parse(v) as WatchedWallet);

    const results = await Promise.all(
      entries.map(async (wallet): Promise<WatchedWalletWithBalance> => {
        const { address, balance, symbol } = await this.getBalance(wallet.address);

        const prev = await this.redis.get(CACHE_KEYS.lastBalance(address));

        if (prev !== null && hasBalanceChanged(prev, balance)) {
          this.events.emit(WALLET_BALANCE_CHANGED, {
            address,
            network: this.network,
            symbol,
            previousBalance: prev,
            currentBalance: balance,
            detectedAt: Date.now(),
          } as WalletBalanceChangedEvent);
        }

        await this.redis.set(CACHE_KEYS.lastBalance(address), balance);

        return {
          address: wallet.address,
          label: wallet.label,
          addedAt: wallet.addedAt,
          balance,
          symbol,
        };
      }),
    );

    return results;
  }

  /**
   * Returns stored balance change alerts from Redis list (newest first).
   * @returns BalanceAlert[] (address, network, previousBalance, currentBalance, symbol, detectedAt)
   */
  async getAlerts(): Promise<BalanceAlert[]> {
    const raw = await this.redis.lrange(CACHE_KEYS.alerts, 0, -1);
    return raw.map((item) => JSON.parse(item) as BalanceAlert);
  }

  /**
   * Returns ERC-20 / SPL token balances for a wallet (Moralis API).
   * Uses Redis cache (TTL 120s). Balance strings are formatted via formatBalance.
   * @param address - EVM (0x...) or Solana (base58) address
   * @returns TokenBalance[] (contractAddress, name, symbol, balance, decimals, network)
   * @throws BadRequestException when fetch fails
   */
  async getTokenBalances(address: string): Promise<TokenBalance[]> {
    const key = CACHE_KEYS.tokens(address);
    const cached = await this.redis.get(key);
    if (cached) return JSON.parse(cached) as TokenBalance[];

    try {
      const raw = await this.fetchMoralisTokens(address);
      const tokens = raw.map((item) => this.mapMoralisToken(item));
      await this.redis.set(key, JSON.stringify(tokens), CACHE_TTL.tokens);
      return tokens;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Request failed';
      throw new BadRequestException(message);
    }
  }

  /**
   * Returns NFTs owned by a wallet (Moralis API for EVM).
   * Uses Redis cache (TTL 300s).
   * @param address - EVM (0x...) or Solana (base58) address
   * @returns NftItem[] (contractAddress, tokenId, name, symbol, network)
   * @throws BadRequestException when fetch fails
   */
  async getNfts(address: string): Promise<NftItem[]> {
    const key = CACHE_KEYS.nfts(address);
    const cached = await this.redis.get(key);
    if (cached) return JSON.parse(cached) as NftItem[];

    try {
      const raw = await this.fetchMoralisNfts(address);
      const nfts = raw.map((item) => this.mapMoralisNft(item));
      await this.redis.set(key, JSON.stringify(nfts), CACHE_TTL.nfts);
      return nfts;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Request failed';
      throw new BadRequestException(message);
    }
  }

  /**
   * Fetches raw transaction list from Etherscan-like Explorer API.
   * @param address - Wallet address
   * @param limit - Page size
   * @returns Array of raw API transactions, or [] if result is not an array
   */
  private async fetchEvmTransactions(
    address: string,
    limit: number,
  ): Promise<EtherscanV2Transaction[]> {
    const { data } = await axios.get<EtherscanV2Response>(this.evm.config.explorerApiUrl, {
      params: {
        chainid: '1',
        module: 'account',
        action: 'txlist',
        address,
        page: 1,
        offset: limit,
        sort: 'desc',
        apikey: this.evm.explorerApiKey,
      },
    });

    const result = data.result;
    return Array.isArray(result) ? result : [];
  }

  /** Maps Etherscan API transaction shape to domain Transaction (value formatted, status normalized). */
  private mapEvmTransaction(tx: EtherscanV2Transaction): Transaction {
    return {
      hash: tx.hash,
      from: tx.from,
      to: tx.to,
      value: formatBalance(tx.value || '0', this.evm.config.decimals),
      timestamp: Number(tx.timeStamp),
      status: tx.txreceipt_status === '0' || tx.isError === '1' ? 'failed' : 'success',
    };
  }

  /** Fetches raw token balances from Moralis wallets API. */
  private async fetchMoralisTokens(address: string): Promise<MoralisTokenResponse[]> {
    const { data } = await axios.get<{ result: MoralisTokenResponse[] }>(
      `${this.moralis.baseUrl}/wallets/${address}/tokens`,
      {
        params: { chain: this.moralis.chainId, exclude_spam: true, exclude_native: true },
        headers: this.moralis.headers,
      },
    );
    return data.result ?? [];
  }

  /** Maps Moralis token response to TokenBalance (balance formatted via formatBalance). */
  private mapMoralisToken(item: MoralisTokenResponse): TokenBalance {
    const decimals = item.decimals ?? 18;
    const balance = formatBalance(item.balance ?? '0', decimals);
    return {
      contractAddress: item.token_address,
      name: item.name,
      symbol: item.symbol,
      balance,
      decimals,
      network: this.network,
    };
  }

  /** Fetches raw NFT list from Moralis API for the given address. */
  private async fetchMoralisNfts(address: string): Promise<MoralisNftResponse[]> {
    const { data } = await axios.get<{ result: MoralisNftResponse[] }>(
      `${this.moralis.baseUrl}/${address}/nft`,
      {
        params: { chain: this.moralis.chainId, exclude_spam: true },
        headers: this.moralis.headers,
      },
    );
    return data.result ?? [];
  }

  /** Maps Moralis NFT response to NftItem. */
  private mapMoralisNft(item: MoralisNftResponse): NftItem {
    return {
      contractAddress: item.token_address,
      tokenId: item.token_id,
      name: item.name ?? '',
      symbol: item.symbol ?? '',
      network: this.network,
    };
  }
}
