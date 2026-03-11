import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import axios from 'axios';
import { WalletService } from './wallet.service';
import { RedisService } from '../redis/redis.service';
import { EvmProvider } from '../blockchain/providers/evm.provider';
import { SolanaProvider } from '../blockchain/providers/solana.provider';
import { Web3Provider } from '../blockchain/providers/web3.provider';
import { TonProvider } from '../blockchain/providers/ton.provider';
import { MoralisProvider } from '../blockchain/providers/moralis.provider';
import { MetaplexProvider } from '../blockchain/providers/metaplex.provider';

jest.mock('axios', () => ({
  default: { get: jest.fn() },
}));

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
};

const mockEvmProvider = {
  provider: { getBalance: jest.fn() },
  config: { decimals: 18, symbol: 'ETH', explorerApiUrl: 'https://api.etherscan.io/api' },
  explorerApiKey: 'test-key',
};

const mockConfigService = {
  get: jest.fn((key: string) => (key === 'NETWORK' ? 'ethereum' : undefined)),
};

describe('WalletService', () => {
  let service: WalletService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockConfigService.get.mockImplementation((key: string) => (key === 'NETWORK' ? 'ethereum' : undefined));
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: RedisService, useValue: mockRedis },
        { provide: EvmProvider, useValue: mockEvmProvider },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: SolanaProvider, useValue: {} },
        { provide: Web3Provider, useValue: {} },
        { provide: TonProvider, useValue: {} },
        { provide: MoralisProvider, useValue: {} },
        { provide: MetaplexProvider, useValue: {} },
      ],
    }).compile();

    service = module.get(WalletService);
  });

  describe('getBalance', () => {
    const address = '0x1234567890123456789012345678901234567890';

    it('returns from cache when cached value exists', async () => {
      const cached = JSON.stringify({
        address,
        balance: '1.500000',
        symbol: 'ETH',
        network: 'ethereum',
      });
      mockRedis.get.mockResolvedValue(cached);

      const result = await service.getBalance(address);

      expect(mockRedis.get).toHaveBeenCalledWith(`balance:${address}`);
      expect(mockEvmProvider.provider.getBalance).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        address,
        balance: '1.500000',
        symbol: 'ETH',
        network: 'ethereum',
        cached: true,
      });
    });

    it('fetches from provider, caches with TTL 30, returns cached: false when cache miss', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockEvmProvider.provider.getBalance.mockResolvedValue(BigInt('1500000000000000000')); // 1.5 ETH in wei

      const result = await service.getBalance(address);

      expect(mockRedis.get).toHaveBeenCalledWith(`balance:${address}`);
      expect(mockEvmProvider.provider.getBalance).toHaveBeenCalledWith(address);
      expect(mockRedis.set).toHaveBeenCalledWith(
        `balance:${address}`,
        expect.stringContaining('"balance":"1.500000"'),
        30,
      );
      expect(result).toMatchObject({
        address,
        balance: '1.500000',
        symbol: 'ETH',
        network: 'ethereum',
        cached: false,
      });
    });

    it('throws BadRequestException with error message when provider fails', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockEvmProvider.provider.getBalance.mockRejectedValue(new Error('invalid address'));

      await expect(service.getBalance(address)).rejects.toThrow(BadRequestException);
      await expect(service.getBalance(address)).rejects.toThrow('invalid address');
      expect(mockRedis.set).not.toHaveBeenCalled();
    });
  });

  describe('getTransactions', () => {
    const address = '0x1234567890123456789012345678901234567890';
    const limit = 10;
    const mockTx = {
      hash: '0xabc',
      from: '0xfrom',
      to: '0xto',
      value: '1000000000000000000',
      timeStamp: '1234567890',
      txreceipt_status: '1',
      isError: '0',
    };

    it('returns from cache when cached value exists', async () => {
      const cached = JSON.stringify({
        address,
        transactions: [],
        network: 'ethereum',
      });
      mockRedis.get.mockResolvedValue(cached);

      const result = await service.getTransactions(address, limit);

      expect(mockRedis.get).toHaveBeenCalledWith(`txs:${address}:${limit}`);
      expect(axios.get).not.toHaveBeenCalled();
      expect(result.cached).toBe(true);
      expect(result.address).toBe(address);
    });

    it('fetches via axios, maps, caches with TTL 60, returns cached: false when cache miss', async () => {
      mockRedis.get.mockResolvedValue(null);
      (axios.get as jest.Mock).mockResolvedValue({
        data: { result: [mockTx] },
      });

      const result = await service.getTransactions(address, limit);

      expect(mockRedis.get).toHaveBeenCalledWith(`txs:${address}:${limit}`);
      expect(axios.get).toHaveBeenCalledWith(
        mockEvmProvider.config.explorerApiUrl,
        expect.objectContaining({
          params: expect.objectContaining({
            address,
            offset: limit,
            module: 'account',
            action: 'txlist',
          }),
        }),
      );
      expect(mockRedis.set).toHaveBeenCalledWith(
        `txs:${address}:${limit}`,
        expect.stringContaining('"hash":"0xabc"'),
        60,
      );
      expect(result).toEqual({
        cached: false,
        address,
        network: 'ethereum',
        transactions: [
          {
            hash: '0xabc',
            from: '0xfrom',
            to: '0xto',
            value: '1.000000',
            timestamp: 1234567890,
            status: 'success',
          },
        ],
      });
    });

    it('throws BadRequestException with error message when fetch fails', async () => {
      mockRedis.get.mockResolvedValue(null);
      (axios.get as jest.Mock).mockRejectedValue(new Error('Network error'));

      await expect(service.getTransactions(address, limit)).rejects.toThrow(BadRequestException);
      await expect(service.getTransactions(address, limit)).rejects.toThrow('Network error');
      expect(mockRedis.set).not.toHaveBeenCalled();
    });
  });
});
