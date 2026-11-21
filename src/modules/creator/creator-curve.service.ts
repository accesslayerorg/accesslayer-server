import { logger } from '../../utils/logger.utils';

export interface GraduatedCurveMilestone {
   supplyThreshold: number;
   exponent: number;
}

export interface MilestoneHistoryEntry {
   milestoneIndex: number;
   supplyAtCrossing: number;
   feeBps: number;
   timestamp: number;
}

export interface CurrentMilestone {
   milestoneIndex: number;
   feeBps: number;
   supplyThreshold: number;
}

export interface CurveGateway {
   configureGraduatedCurve(input: {
      creatorId: string;
      milestones: GraduatedCurveMilestone[];
   }): Promise<{ transactionHash?: string }>;
   getCurrentMilestone(input: {
      creatorId: string;
   }): Promise<CurrentMilestone>;
   getMilestoneHistory(input: {
      creatorId: string;
   }): Promise<MilestoneHistoryEntry[]>;
}

export const curveGateway: CurveGateway = {
   async configureGraduatedCurve(input) {
      logger.info(
         {
            operation: 'configure_graduated_curve_contract_call',
            keyId: input.creatorId,
            milestones: input.milestones,
         },
         'Submitting configure_graduated_curve contract call'
      );
      return { transactionHash: undefined };
   },

   async getCurrentMilestone(input) {
      logger.info(
         {
            operation: 'get_current_milestone_contract_call',
            keyId: input.creatorId,
         },
         'Submitting get_current_milestone contract call'
      );
      return { milestoneIndex: 0, feeBps: 0, supplyThreshold: 0 };
   },

   async getMilestoneHistory(input) {
      logger.info(
         {
            operation: 'get_milestone_history_contract_call',
            keyId: input.creatorId,
         },
         'Submitting get_milestone_history contract call'
      );
      return [];
   },
};
