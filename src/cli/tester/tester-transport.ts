import { promise, orders, math } from '@debut/plugin-utils';
import {
    BaseTransport,
    TickHandler,
    Instrument,
    ExecutedOrder,
    Candle,
    TestingPhase,
    DebutOptions,
    PendingOrder,
} from '@debut/types';
import { generateOHLC } from './history';
import { DepthHandler } from '@debut/types';

type TesterTransportOptions = {
    ticker: string;
    ohlc?: boolean;
    broker?: string;
};

export class TesterTransport implements BaseTransport {
    public done: Promise<boolean>;
    private handlers: TickHandler[] = [];
    public opts: TesterTransportOptions;
    public complete: Promise<void>;
    private resolve: () => void;
    private onPhase: (phase: TestingPhase) => Promise<void> = () => Promise.resolve();
    private tickPhases: {
        before: Candle[];
        main: Candle[];
        after: Candle[];
    };

    constructor(opts: TesterTransportOptions) {
        this.opts = opts;
        this.reset();
        this.tickPhases = {
            before: [],
            main: [],
            after: [],
        };
    }

    public async getInstrument(opts: DebutOptions) {
        const instrumentId = this.getInstrumentId(opts);

        if (!this.tickPhases.main.length) {
            throw new Error('transport is not ready, set ticks before bot.start() call');
        }

        return {
            figi: 'test',
            ticker: this.opts.ticker,
            lotPrecision: 10,
            lot: 1,
            currency: 'USD',
            id: instrumentId,
            type: opts.instrumentType,
            minNotional: 0,
            minQuantity: 0,
        } as Instrument;
    }

    public setTicks(ticks: Candle[]) {
        this.tickPhases.main = ticks.slice();

        if (this.opts.ohlc) {
            this.tickPhases.main = generateOHLC(this.tickPhases.main);

            console.log('OHLC Ticks is enabled, total ticks:', this.tickPhases.main.length);
        }
    }

    public async run(waitFor?: boolean): Promise<void> {
        if (waitFor) {
            const prev = this.handlers.length;
            await promise.sleep(1000);
            if (prev !== this.handlers.length) {
                return this.run(waitFor);
            }
        }

        await this.tickLoop(this.tickPhases.before);
        await this.onPhase(TestingPhase.before);
        await this.tickLoop(this.tickPhases.main);
        await this.onPhase(TestingPhase.main);
        await this.tickLoop(this.tickPhases.after);
        await this.onPhase(TestingPhase.after);
    }

    public reset() {
        this.handlers.length = 0;

        // Установим новый ресолвер
        this.complete = new Promise((resolve) => {
            this.resolve = resolve;
        });
    }

    public createCrossValidation(gap = 20, onPhase: (phase: TestingPhase) => Promise<void>) {
        const beforeEndTime = this.tickPhases.main[0].time + 86400000 * gap;
        const beforeIdx = this.tickPhases.main.findIndex((tick) => tick.time > beforeEndTime) - 1;

        this.tickPhases.before = this.tickPhases.main.splice(0, beforeIdx);

        const afterStartTime = this.tickPhases.main[this.tickPhases.main.length - 1].time - 86400000 * gap;
        const afterIdx = this.tickPhases.main.findIndex((tick) => tick.time > afterStartTime) - 1;
        const diff = this.tickPhases.main.length - afterIdx;
        this.tickPhases.after = this.tickPhases.main.splice(afterIdx, diff);

        this.onPhase = onPhase;
    }

    public subscribeToTick(opts: DebutOptions, handler: TickHandler) {
        this.handlers.push(handler);

        return Promise.resolve(() => {
            const idx = this.handlers.indexOf(handler);

            if (idx !== -1) {
                this.handlers.splice(idx, 1);
            }
        });
    }

    public subscribeOrderBook(opts: DebutOptions, handler: DepthHandler) {
        return null;
    }

    public async placeOrder(order: PendingOrder, opts: DebutOptions): Promise<ExecutedOrder> {
        const feeAmount = order.price * order.lots * (opts.fee / 100);
        const commission = { value: feeAmount, currency: 'USD' };
        const executed: ExecutedOrder = {
            ...order,
            orderId: orders.syntheticOrderId(order),
            executedLots: order.lots,
            commission,
        };

        return executed;
    }

    public placeSandboxOrder(order: PendingOrder, opts: DebutOptions) {
        return this.placeOrder(order, opts);
    }

    public async getUsdBalance() {
        return Infinity;
    }

    public prepareLots(lots: number) {
        switch (this.opts.broker) {
            case 'binance':
                return math.toFixed(lots, 6);
            case 'tinkoff':
            default:
                return Math.floor(lots) || 1;
        }
    }

    private async tickLoop(ticks: Candle[]) {
        let tickIdx = 0;
        let tick = ticks[0];

        while (tick) {
            let handler = this.handlers[0];
            let handlerIdx = 0;

            while (handler) {
                await handler(tick);
                handler = this.handlers[++handlerIdx];
            }

            tick = ticks[++tickIdx];
        }

        this.resolve();
    }

    private getInstrumentId(opts: DebutOptions) {
        return `${opts.ticker}:${opts.instrumentType}`;
    }
}
