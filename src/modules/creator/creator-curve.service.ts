import { logger } from '../../utils/logger.utils';

export interface GraduatedCurveMilestone {
   supplyThreshold: number;
   exponent: number;
}

export interface CurveGateway {
   configureGraduatedCurve(input: {
      creatorId: string;
      milestones: GraduatedCurveMilestone[];
   }): Promise<{ transactionHash?: string }>;
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
};
