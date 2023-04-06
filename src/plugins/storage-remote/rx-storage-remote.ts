import {
    firstValueFrom,
    filter,
    Observable,
    Subject,
    Subscription
} from 'rxjs';
import type {
    BulkWriteRow,
    EventBulk,
    RxConflictResultionTask,
    RxConflictResultionTaskSolution,
    RxDocumentData,
    RxDocumentDataById,
    RxJsonSchema,
    RxStorage,
    RxStorageBulkWriteResponse,
    RxStorageChangeEvent,
    RxStorageCountResult,
    RxStorageInstance,
    RxStorageInstanceCreationParams,
    RxStorageQueryResult,
    RxStorageStatics
} from '../../types';
import {
    randomCouchString
} from '../../plugins/utils';
import type {
    MessageFromRemote,
    MessageToRemote,
    RxStorageRemoteInternals,
    RxStorageRemoteSettings
} from './storage-remote-types';
import { closeMessageChannel, getMessageChannel } from './message-channel-cache';


export class RxStorageRemote implements RxStorage<RxStorageRemoteInternals, any> {
    public readonly statics: RxStorageStatics;
    public readonly name: string = 'remote';
    private seed: string = randomCouchString(10);
    private lastRequestId: number = 0;
    constructor(
        public readonly settings: RxStorageRemoteSettings
    ) {
        this.statics = settings.statics;
    }

    public getRequestId() {
        const newId = this.lastRequestId++;
        return this.seed + '|' + newId;
    }

    async createStorageInstance<RxDocType>(
        params: RxStorageInstanceCreationParams<RxDocType, any>
    ): Promise<RxStorageInstanceRemote<RxDocType>> {
        const connectionId = 'c|' + this.getRequestId();

        const cacheKeys: string[] = [
            'mode-' + this.settings.mode
        ];
        switch (this.settings.mode) {
            case 'collection':
                cacheKeys.push('collection-' + params.collectionName);
            // eslint-disable-next-line no-fallthrough
            case 'database':
                cacheKeys.push('database-' + params.databaseName);
            // eslint-disable-next-line no-fallthrough
            case 'storage':
                cacheKeys.push('seed-' + this.seed);
        }
        console.log('cacheKeys:');
        console.dir(cacheKeys);
        const messageChannel = await getMessageChannel(
            this.settings,
            cacheKeys
        );

        const requestId = this.getRequestId();
        const waitForOkPromise = firstValueFrom(messageChannel.messages$.pipe(
            filter(msg => msg.answerTo === requestId)
        ));
        messageChannel.send({
            connectionId,
            method: 'create',
            requestId,
            params
        });

        const waitForOkResult = await waitForOkPromise;
        if (waitForOkResult.error) {
            throw new Error('could not create instance ' + JSON.stringify(waitForOkResult.error));
        }

        return new RxStorageInstanceRemote(
            this,
            params.databaseName,
            params.collectionName,
            params.schema,
            {
                params,
                connectionId,
                messageChannel
            },
            params.options
        );
    }

    async customRequest<In, Out>(data: In): Promise<Out> {
        const messageChannel = await this.settings.messageChannelCreator();
        const requestId = this.getRequestId();
        const connectionId = 'custom|request|' + requestId;
        const waitForAnswerPromise = firstValueFrom(messageChannel.messages$.pipe(
            filter(msg => msg.answerTo === requestId)
        ));
        messageChannel.send({
            connectionId,
            method: 'custom',
            requestId,
            params: data
        });
        const response = await waitForAnswerPromise;
        if (response.error) {
            await messageChannel.close();
            throw new Error('could not run customRequest(): ' + JSON.stringify({
                data,
                error: response.error
            }));
        } else {
            await messageChannel.close();
            return response.return;
        }

    }
}

export class RxStorageInstanceRemote<RxDocType> implements RxStorageInstance<RxDocType, RxStorageRemoteInternals, any, any> {
    private changes$: Subject<EventBulk<RxStorageChangeEvent<RxDocumentData<RxDocType>>, any>> = new Subject();
    private conflicts$: Subject<RxConflictResultionTask<RxDocType>> = new Subject();
    private subs: Subscription[] = [];

    private closed: boolean = false;
    messages$: Observable<MessageFromRemote>;

    constructor(
        public readonly storage: RxStorageRemote,
        public readonly databaseName: string,
        public readonly collectionName: string,
        public readonly schema: Readonly<RxJsonSchema<RxDocumentData<RxDocType>>>,
        public readonly internals: RxStorageRemoteInternals,
        public readonly options: Readonly<any>
    ) {
        this.messages$ = this.internals.messageChannel.messages$.pipe(
            filter(msg => msg.connectionId === this.internals.connectionId)
        );
        this.subs.push(
            this.messages$.subscribe(msg => {
                if (msg.method === 'changeStream') {
                    this.changes$.next(msg.return);
                }
                if (msg.method === 'conflictResultionTasks') {
                    this.conflicts$.next(msg.return);
                }
            })
        );
    }

    private async requestRemote(
        methodName: keyof RxStorageInstance<any, any, any>,
        params: any
    ) {
        const requestId = this.storage.getRequestId();
        const responsePromise = firstValueFrom(
            this.messages$.pipe(
                filter(msg => msg.answerTo === requestId)
            )
        );
        const message: MessageToRemote = {
            connectionId: this.internals.connectionId,
            requestId,
            method: methodName,
            params
        };
        this.internals.messageChannel.send(message);
        const response = await responsePromise;
        if (response.error) {
            throw new Error('could not requestRemote: ' + JSON.stringify({
                methodName,
                params,
                error: response.error
            }, null, 4));
        } else {
            return response.return;
        }
    }
    bulkWrite(
        documentWrites: BulkWriteRow<RxDocType>[],
        context: string
    ): Promise<RxStorageBulkWriteResponse<RxDocType>> {
        return this.requestRemote('bulkWrite', [documentWrites, context]);
    }
    findDocumentsById(ids: string[], deleted: boolean): Promise<RxDocumentDataById<RxDocType>> {
        return this.requestRemote('findDocumentsById', [ids, deleted]);
    }
    query(preparedQuery: any): Promise<RxStorageQueryResult<RxDocType>> {
        return this.requestRemote('query', [preparedQuery]);
    }
    count(preparedQuery: any): Promise<RxStorageCountResult> {
        return this.requestRemote('count', [preparedQuery]);
    }
    getAttachmentData(documentId: string, attachmentId: string): Promise<string> {
        return this.requestRemote('getAttachmentData', [documentId, attachmentId]);
    }
    getChangedDocumentsSince(
        limit: number,
        checkpoint?: any
    ): Promise<
        {
            documents: RxDocumentData<RxDocType>[];
            checkpoint: any;
        }> {
        return this.requestRemote('getChangedDocumentsSince', [limit, checkpoint]);
    }
    changeStream(): Observable<EventBulk<RxStorageChangeEvent<RxDocumentData<RxDocType>>, any>> {
        return this.changes$.asObservable();
    }
    cleanup(minDeletedTime: number): Promise<boolean> {
        return this.requestRemote('cleanup', [minDeletedTime]);
    }
    async close(): Promise<void> {
        if (this.closed) {
            return Promise.reject(new Error('already closed'));
        }
        this.closed = true;
        this.subs.forEach(sub => sub.unsubscribe());
        this.changes$.complete();
        await this.requestRemote('close', []);
        await closeMessageChannel(this.internals.messageChannel);
    }
    async remove(): Promise<void> {
        this.closed = true;
        await this.requestRemote('remove', []);
        await closeMessageChannel(this.internals.messageChannel);
    }
    conflictResultionTasks(): Observable<RxConflictResultionTask<RxDocType>> {
        return this.conflicts$;
    }
    async resolveConflictResultionTask(taskSolution: RxConflictResultionTaskSolution<RxDocType>): Promise<void> {
        await this.requestRemote('resolveConflictResultionTask', [taskSolution]);
    }
}

export function getRxStorageRemote(settings: RxStorageRemoteSettings): RxStorageRemote {
    const withDefaults = Object.assign({
        mode: 'storage'
    }, settings);
    return new RxStorageRemote(withDefaults);
}
