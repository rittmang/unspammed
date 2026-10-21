// Loaded only inside TelegramAdmin, never in the dashboard or moderation request path.
import { TelegramClient, Api } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { Logger, LogLevel } from 'teleproto/extensions/Logger';
import { computeCheck } from 'teleproto/Password';
import bigInt from 'big-integer';
import { HttpError } from './http';

export interface AdminAccount {
  id: string;
  name: string;
}
export interface AdminClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  save(): string;
  sendCode(phone: string): Promise<string>;
  signIn(phone: string, hash: string, code: string): Promise<void>;
  password(password: string): Promise<void>;
  me(): Promise<AdminAccount>;
  logout(): Promise<void>;
  deleteHistory(chatId: string, userId: string): Promise<number>;
}
export type AdminClientFactory = (
  session: string,
  apiId: number,
  apiHash: string,
) => Promise<AdminClient>;

export const createAdminClient: AdminClientFactory = async (saved, apiId, apiHash) => {
  const session = new StringSession(saved);
  const client = new TelegramClient(session, apiId, apiHash, {
    baseLogger: new Logger(LogLevel.NONE),
    deviceModel: 'Watchtower admin',
    systemVersion: 'Watchtower',
    appVersion: '1.0',
    connectionRetries: 1,
    reconnectRetries: 0,
    // Telegram redirects first-time logins to the account's home data center.
    // The SDK applies that redirect only when another attempt is available.
    requestRetries: 3,
    autoReconnect: false,
    floodSleepThreshold: 0,
    timeout: 10,
  });
  const invoke = <R extends Api.AnyRequest>(request: R) =>
    client.invoke(request, undefined, {
      timeout: 15_000,
      maxRetryCount: 2,
      floodSleepThreshold: 0,
    });
  return {
    connect: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          client.connect(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new HttpError(503, 'Telegram connection timed out. Try again.')),
              20_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    close: async () => {
      await client.destroy();
    },
    save: () => session.save(),
    sendCode: async (phone) => {
      const result = await client.sendCode({ apiId, apiHash }, phone);
      if (result.emailRequired || result.emailCodeSent || !result.phoneCodeHash)
        throw new HttpError(
          409,
          'Telegram requires an additional login step. Sign in with the Telegram app and try again.',
        );
      return result.phoneCodeHash;
    },
    signIn: async (phoneNumber, phoneCodeHash, phoneCode) => {
      const result = await invoke(new Api.auth.SignIn({ phoneNumber, phoneCodeHash, phoneCode }));
      if (!(result instanceof Api.auth.Authorization))
        throw new HttpError(
          403,
          'Use your existing Telegram owner account. Account registration is not supported.',
        );
    },
    password: async (password) => {
      const parameters = await invoke(new Api.account.GetPassword());
      await invoke(
        new Api.auth.CheckPassword({ password: await computeCheck(parameters, password) }),
      );
    },
    me: async () => {
      const me = await client.getMe();
      if (me.bot) throw new HttpError(403, 'Connect your Telegram user account, not a bot.');
      return { id: me.id.toString(), name: [me.firstName, me.lastName].filter(Boolean).join(' ') };
    },
    logout: async () => {
      await invoke(new Api.auth.LogOut());
    },
    deleteHistory: async (chatId, userId) => {
      // Dialogs supply access hashes for private groups. Never resolve by a mutable username.
      const dialogs = await client.getDialogs({ limit: 1000 });
      const dialog = dialogs.find((d) => d.id?.toString() === chatId);
      if (!dialog?.entity || !(dialog.entity instanceof Api.Channel))
        throw new HttpError(
          403,
          'Your connected account must be a member and admin of this supergroup.',
        );
      const entity = dialog.entity;
      if (!entity.megagroup || (!entity.creator && !entity.adminRights?.deleteMessages))
        throw new HttpError(
          403,
          'Your connected account needs Delete messages permission in this supergroup.',
        );
      const channel = new Api.InputChannel({
        channelId: entity.id,
        accessHash: entity.accessHash!,
      });
      let peer: Api.TypeInputPeer | undefined;
      // getParticipant often resolves a group member by ID without a cached hash.
      try {
        const participant = await invoke(
          new Api.channels.GetParticipant({
            channel,
            participant: new Api.InputPeerUser({ userId: bigInt(userId), accessHash: bigInt.zero }),
          }),
        );
        if (
          participant.participant instanceof Api.ChannelParticipantAdmin ||
          participant.participant instanceof Api.ChannelParticipantCreator
        )
          throw new HttpError(403, 'Administrators and the group creator are protected.');
        const user = participant.users.find((u) => u.id.toString() === userId);
        if (user instanceof Api.User && user.accessHash)
          peer = new Api.InputPeerUser({ userId: user.id, accessHash: user.accessHash });
      } catch (error) {
        if (
          !/^(USER_ID_INVALID|PARTICIPANT_ID_INVALID|PEER_ID_INVALID|USER_NOT_PARTICIPANT)$/.test(
            String((error as { errorMessage?: string })?.errorMessage),
          )
        )
          throw error;
      }
      // Banned users remain in the kicked list, even after their tracked messages are gone.
      if (!peer) {
        for (const filter of [
          new Api.ChannelParticipantsKicked({ q: '' }),
          new Api.ChannelParticipantsSearch({ q: '' }),
        ]) {
          for (let offset = 0; offset < 10000; offset += 200) {
            const result = await invoke(
              new Api.channels.GetParticipants({
                channel,
                filter,
                offset,
                limit: 200,
                hash: bigInt.zero,
              }),
            );
            if (!(result instanceof Api.channels.ChannelParticipants)) break;
            const user = result.users.find((u) => u.id.toString() === userId);
            if (user instanceof Api.User && user.accessHash) {
              peer = new Api.InputPeerUser({ userId: user.id, accessHash: user.accessHash });
              break;
            }
            if (result.participants.length < 200) break;
          }
          if (peer) break;
        }
      }
      if (!peer)
        throw new HttpError(
          409,
          'Telegram could not resolve this user in the group. Retry while one of their messages is still visible, or use Telegram’s native cleanup.',
        );
      // Recheck protection using the resolved access hash immediately before deletion.
      const member = await invoke(new Api.channels.GetParticipant({ channel, participant: peer }));
      if (
        member.participant instanceof Api.ChannelParticipantAdmin ||
        member.participant instanceof Api.ChannelParticipantCreator
      )
        throw new HttpError(403, 'Administrators and the group creator are protected.');
      const result = await invoke(
        new Api.channels.DeleteParticipantHistory({ channel, participant: peer }),
      );
      return result.offset;
    },
  };
};
