import { Injectable } from '@nestjs/common';
import { getNativeTreasuryAddress, VoteTipping, VoteThresholdType } from '@solana/spl-governance';
import { PublicKey } from '@solana/web3.js';
import { BigNumber } from 'bignumber.js';
import { hoursToMilliseconds, millisecondsToHours, secondsToHours } from 'date-fns';
import * as EI from 'fp-ts/Either';

import * as errors from '@lib/errors/gql';
import { HolaplexService } from '@src/holaplex/holaplex.service';
import { Environment } from '@src/lib/types/Environment';
import { OnChainService } from '@src/on-chain/on-chain.service';
import { StaleCacheService } from '@src/stale-cache/stale-cache.service';

import { GovernanceRules, GovernanceTokenType, GovernanceVoteTipping } from './dto/GovernanceRules';
import * as queries from './holaplexQueries';

const MAX_NUM = new BigNumber('18446744073709551615');

export interface Governance {
  address: PublicKey;
  communityMint: PublicKey | null;
  councilMint: PublicKey | null;
  communityMintMaxVoteWeight: BigNumber | null;
  communityMintMaxVoteWeightSource: string | null;
}

function voteTippingToGovernanceVoteTipping(voteTipping: VoteTipping | string) {
  switch (voteTipping) {
    case VoteTipping.Disabled:
      return GovernanceVoteTipping.Disabled;
    case VoteTipping.Early:
      return GovernanceVoteTipping.Early;
    case VoteTipping.Strict:
      return GovernanceVoteTipping.Strict;
    case 'DISABLED':
      return GovernanceVoteTipping.Disabled;
    case 'EARLY':
      return GovernanceVoteTipping.Early;
    case 'STRICT':
      return GovernanceVoteTipping.Strict;
    default:
      return GovernanceVoteTipping.Disabled;
  }
}

@Injectable()
export class RealmGovernanceService {
  constructor(
    private readonly holaplexService: HolaplexService,
    private readonly onChainService: OnChainService,
    private readonly staleCacheService: StaleCacheService,
  ) {}

  /**
   * Get a list of governances for a realm
   */
  async getGovernancesForRealm(realmPublicKey: PublicKey, environment: Environment) {
    if (environment === 'devnet') {
      throw new errors.UnsupportedDevnet();
    }

    const governances = await this.holaplexGetGovernances(realmPublicKey);
    return governances.map((data) => {
      const governance: Governance = {
        address: new PublicKey(data.address),
        communityMint: data.realm?.communityMint ? new PublicKey(data.realm.communityMint) : null,
        councilMint: data.realm?.realmConfig?.councilMint
          ? new PublicKey(data.realm.realmConfig.councilMint)
          : null,
        communityMintMaxVoteWeight: data.realm?.realmConfig?.communityMintMaxVoteWeight
          ? new BigNumber(data.realm.realmConfig.communityMintMaxVoteWeight)
          : null,
        communityMintMaxVoteWeightSource:
          data.realm?.realmConfig?.communityMintMaxVoteWeightSource || null,
      };

      return governance;
    });
  }

  /**
   * Get the rules for a governance
   */
  async getGovernanceRules(
    programPublicKey: PublicKey,
    governanceAddress: PublicKey,
    environment: Environment,
  ) {
    const walletAddress = await getNativeTreasuryAddress(programPublicKey, governanceAddress);
    const programVersion = await this.onChainService.getProgramVersion(programPublicKey);
    const governanceAccount = await this.onChainService.getGovernanceAccount(governanceAddress);
    const onChainConfig = governanceAccount.account.config;

    const resp = await this.holaplexService.requestV1(
      {
        query: queries.governance.query,
        variables: { address: governanceAddress.toBase58() },
      },
      queries.governance.resp,
    )();

    if (EI.isLeft(resp)) {
      throw resp.left;
    }

    const governance = resp.right.governances[0];
    const holaplexConfig = governance?.governanceConfig || {
      governanceAddress,
      voteThresholdType: 'QUORUM',
      voteThresholdPercentage: onChainConfig.communityVoteThreshold.value || 60,
      minCommunityWeightToCreateProposal:
        onChainConfig.minCommunityTokensToCreateProposal.toString(),
      minInstructionHoldUpTime: onChainConfig.minInstructionHoldUpTime.toString(),
      maxVotingTime: onChainConfig.maxVotingTime.toString(),
      voteTipping: onChainConfig.communityVoteTipping,
      proposalCoolOffTime: '0',
      minCouncilWeightToCreateProposal: onChainConfig.minCouncilTokensToCreateProposal.toString(),
    };
    let councilMint = governance?.realm?.realmConfig?.councilMint;
    let communityMint = governance?.realm?.communityMint;

    if (!governance) {
      const realmPublicKey = governanceAccount.account.realm;
      const realmAccount = await this.onChainService.getRealmAccount(realmPublicKey);

      councilMint = realmAccount.account.config.councilMint?.toBase58();
      communityMint = realmAccount.account.communityMint.toBase58();
    }

    if (!holaplexConfig || !communityMint) {
      throw new errors.MalformedData();
    }

    const [councilMintInfo, communityMintInfo] = await Promise.all([
      councilMint
        ? this.onChainService.getTokenMintInfo(new PublicKey(councilMint), environment)
        : null,
      this.onChainService.getTokenMintInfo(new PublicKey(communityMint), environment),
    ]);

    const rules: GovernanceRules = {
      governanceAddress,
      walletAddress,
      coolOffHours:
        programVersion >= 3 ? millisecondsToHours(parseInt(holaplexConfig.proposalCoolOffTime)) : 0, // FIX
      councilTokenRules: councilMintInfo
        ? {
            canCreateProposal: new BigNumber(
              holaplexConfig.minCouncilWeightToCreateProposal,
            ).isLessThan(MAX_NUM),
            canVeto:
              onChainConfig.councilVetoVoteThreshold?.type ===
                VoteThresholdType.YesVotePercentage ||
              onChainConfig.councilVetoVoteThreshold?.type === VoteThresholdType.QuorumPercentage
                ? true
                : false,
            canVote:
              onChainConfig.councilVoteThreshold?.type === VoteThresholdType.Disabled
                ? false
                : true,
            quorumPercent: onChainConfig.councilVoteThreshold
              ? onChainConfig.councilVoteThreshold.type === VoteThresholdType.Disabled
                ? 100
                : onChainConfig.councilVoteThreshold.value || 60
              : holaplexConfig.voteThresholdPercentage,
            tokenMintAddress: councilMintInfo.publicKey,
            tokenType: GovernanceTokenType.Council,
            totalSupply: new BigNumber(councilMintInfo.account.supply.toString()).shiftedBy(
              -councilMintInfo.account.decimals,
            ),
            vetoQuorumPercent: onChainConfig.councilVetoVoteThreshold
              ? onChainConfig.councilVetoVoteThreshold.type === VoteThresholdType.Disabled
                ? 100
                : onChainConfig.councilVetoVoteThreshold.value || 60
              : 100,
            voteTipping: onChainConfig.councilVoteTipping
              ? voteTippingToGovernanceVoteTipping(onChainConfig.councilVoteTipping)
              : voteTippingToGovernanceVoteTipping(holaplexConfig.voteTipping),
            votingPowerToCreateProposals: new BigNumber(
              holaplexConfig.minCouncilWeightToCreateProposal,
            ).shiftedBy(-councilMintInfo.account.decimals),
          }
        : null,
      communityTokenRules: {
        canCreateProposal: new BigNumber(
          holaplexConfig.minCommunityWeightToCreateProposal,
        ).isLessThan(MAX_NUM),
        canVeto:
          onChainConfig.communityVetoVoteThreshold?.type === VoteThresholdType.YesVotePercentage ||
          onChainConfig.communityVetoVoteThreshold?.type === VoteThresholdType.QuorumPercentage
            ? true
            : false,
        canVote:
          onChainConfig.communityVoteThreshold?.type === VoteThresholdType.Disabled ? false : true,
        quorumPercent: onChainConfig.communityVoteThreshold
          ? onChainConfig.communityVoteThreshold.type === VoteThresholdType.Disabled
            ? 100
            : onChainConfig.communityVoteThreshold.value || 60
          : holaplexConfig.voteThresholdPercentage,
        tokenMintAddress: communityMintInfo.publicKey,
        tokenType: GovernanceTokenType.Community,
        totalSupply: new BigNumber(communityMintInfo.account.supply.toString()).shiftedBy(
          -communityMintInfo.account.decimals,
        ),
        vetoQuorumPercent: onChainConfig.communityVetoVoteThreshold
          ? onChainConfig.communityVetoVoteThreshold.type === VoteThresholdType.Disabled
            ? 100
            : onChainConfig.communityVetoVoteThreshold.value || 60
          : 100,
        voteTipping: onChainConfig.communityVoteTipping
          ? voteTippingToGovernanceVoteTipping(onChainConfig.communityVoteTipping)
          : voteTippingToGovernanceVoteTipping(holaplexConfig.voteTipping),
        votingPowerToCreateProposals: new BigNumber(
          holaplexConfig.minCommunityWeightToCreateProposal,
        ).shiftedBy(-communityMintInfo.account.decimals),
      },
      depositExemptProposalCount: (onChainConfig as any)['depositExemptProposalCount'] || 10,
      maxVoteDays: secondsToHours(parseInt(holaplexConfig.maxVotingTime, 10)) / 24,
      minInstructionHoldupDays:
        secondsToHours(parseInt(holaplexConfig.minInstructionHoldUpTime, 10)) / 24,
      version: programVersion,
    };

    return rules;
  }

  /**
   * Get governances from holaplex
   */
  private readonly holaplexGetGovernances = this.staleCacheService.dedupe(
    async (realm: PublicKey) => {
      const resp = await this.holaplexService.requestV1(
        {
          query: queries.realmGovernance.query,
          variables: {
            realms: [realm.toBase58()],
          },
        },
        queries.realmGovernance.resp,
      )();

      if (EI.isLeft(resp)) {
        throw resp.left;
      }

      return resp.right.governances;
    },
    {
      dedupeKey: (realm) => realm.toBase58(),
      maxStaleAgeMs: hoursToMilliseconds(6),
    },
  );
}
