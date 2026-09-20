export interface SellGateway {
   submitSell(input: {
      walletAddress: string;
      creatorId: string;
      quantity: number;
   }): Promise<{ transactionHash: string; confirmed?: boolean }>;
}

export const sellGateway: SellGateway = {
   async submitSell(_input: {
      walletAddress: string;
      creatorId: string;
      quantity: number;
   }) {
      return {
         transactionHash: `tx-sell-${Date.now()}`,
         confirmed: true,
      };
   },
};
