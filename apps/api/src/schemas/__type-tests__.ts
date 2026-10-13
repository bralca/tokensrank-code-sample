import type {
  AccessKeyListItem,
  IngestRequest,
  IngestResponse,
  LeaderboardRow,
  SignUpRequest,
} from '@tokensrank/shared';

type Assert<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsNotAny<T> = IsAny<T> extends true ? false : true;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;

type IngestSession = IngestRequest['sessions'][number];

type _SignUpRequestIsNotAny = Assert<IsNotAny<SignUpRequest>>;
type _SignUpEmailIsString = Assert<Equal<SignUpRequest['email'], string>>;
type _SignUpHandleIsString = Assert<Equal<SignUpRequest['handle'], string>>;
type _SignUpDisplayNameIsNotPresent = Assert<Equal<Extract<'displayName', keyof SignUpRequest>, never>>;

type _IngestRequestIsNotAny = Assert<IsNotAny<IngestRequest>>;
type _IngestSessionIsNotAny = Assert<IsNotAny<IngestSession>>;
type _IngestSessionsIsTypedArray = Assert<Equal<IngestRequest['sessions'], IngestSession[]>>;
type _IngestSessionSourceIsNarrow = Assert<Equal<IngestSession['source'], 'claude' | 'codex' | 'opencode'>>;
type _IngestSessionInputTokensAreNumber = Assert<Equal<IngestSession['input_tokens'], number>>;
type _IngestClientPlatformIsOptional = Assert<
  Equal<IngestRequest['client']['platform'], 'darwin' | 'linux' | 'win32' | undefined>
>;

type _IngestResponseIsNotAny = Assert<IsNotAny<IngestResponse>>;
type _IngestResponseRejectedDetailsTyped = Assert<
  Equal<IngestResponse['rejected_details'][number]['reason_code'], (
    | 'rate_limited'
    | 'schema_invalid'
    | 'future_timestamp'
    | 'timestamp_too_old'
    | 'ratchet_violation'
    | 'bounds_violation'
    | 'fingerprint_critical'
  )>
>;

type _AccessKeyListItemIsNotAny = Assert<IsNotAny<AccessKeyListItem>>;
type _AccessKeyScopeIsNarrow = Assert<Equal<AccessKeyListItem['scope'], 'script' | 'self_reported'>>;
type _AccessKeyPlaintextIsNotListed = Assert<
  Equal<Extract<'plaintext', keyof AccessKeyListItem>, never>
>;

type _LeaderboardRowIsNotAny = Assert<IsNotAny<LeaderboardRow>>;
type _LeaderboardModeIsNarrow = Assert<
  Equal<LeaderboardRow['mode'], 'script_verified' | 'self_reported'>
>;
type _LeaderboardBadgesAreTyped = Assert<IsNotAny<LeaderboardRow['badges'][number]>>;
