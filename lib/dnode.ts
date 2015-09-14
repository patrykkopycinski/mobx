/// <reference path="./api.ts" />

declare var __mobservableViewStack:mobservable._.ObservingDNode[];

namespace mobservable {

    var globalScope = (function() { return this; })()

    // DNode[][], stack of: list of DNode's being observed by the currently ongoing computation
    if (globalScope.__mobservableTrackingStack)
        throw new Error("An incompatible version of mobservable is already loaded.");
    globalScope.__mobservableViewStack = [];

    export namespace _ {

        var mobservableId = 0;



        export enum DNodeState {
            STALE,     // One or more depencies have changed but their values are not yet known, current value is stale
            PENDING,   // All dependencies are up to date again, a recalculation of this node is ongoing or pending, current value is stale
            READY,     // Everything is bright and shiny
        };

        /**
         * A root node in the dependency graph. This node can be observed by others, but doesn't observe anything itself.
         * Represents the state of some State.
         */
        export class RootDNode {

            id = ++mobservableId;
            state: DNodeState = DNodeState.READY;
            observers: ObservingDNode[] = [];       // nodes that are dependent on this node. Will be notified when our state change
            protected isDisposed = false;            // ready to be garbage collected. Nobody is observing or ever will observe us
            externalRefenceCount = 0;      // nr of 'things' that depend on us, excluding other DNode's. If > 0, this node will not go to sleep

            constructor(public context:Mobservable.IContextInfoStruct) {
                if (!context.name)
                    context.name = "[m#" + this.id + "]";
            }

            setRefCount(delta:number) {
                this.externalRefenceCount += delta;
            }

            addObserver(node:ObservingDNode) {
                this.observers[this.observers.length] = node;
            }

            removeObserver(node:ObservingDNode) {
                var obs = this.observers, idx = obs.indexOf(node);
                if (idx !== -1)
                    obs.splice(idx, 1);
            }

            markStale() {
                if (this.state !== DNodeState.READY)
                    return; // stale or pending; recalculation already scheduled, we're fine..
                this.state = DNodeState.STALE;
                if (_.transitionTracker)
                    _.reportTransition(this, "STALE");
                this.notifyObservers();
            }

            markReady(stateDidActuallyChange:boolean) {
                if (this.state === DNodeState.READY)
                    return;
                this.state = DNodeState.READY;
                if (_.transitionTracker)
                    _.reportTransition(this, "READY", true, this["_value"]);
                this.notifyObservers(stateDidActuallyChange);
            }

            notifyObservers(stateDidActuallyChange:boolean=false) {
                var os = this.observers.slice();
                for(var l = os.length, i = 0; i < l; i++)
                    os[i].notifyStateChange(this, stateDidActuallyChange);
            }

            public notifyObserved() {
                var ts = __mobservableViewStack, l = ts.length;
                if (l > 0) {
                    var deps = ts[l-1].observing, depslength = deps.length;
                    // this last item added check is an optimization especially for array loops,
                    // because an array.length read with subsequent reads from the array
                    // might trigger many observed events, while just checking the latest added items is cheap
                    // (n.b.: this code is inlined and not in observable view for performance reasons)
                    if (deps[depslength -1] !== this && deps[depslength -2] !== this)
                        deps[depslength] = this;
                }
            }

            public dispose() {
                if (this.observers.length)
                    throw new Error("Cannot dispose DNode; it is still being observed");
                this.isDisposed = true;
            }

            public toString() {
                return `DNode[${this.context.name}, state: ${this.state}, observers: ${this.observers.length}]`;
            }
        }

        /**
         * A node in the state dependency root that observes other nodes, and can be observed itself.
         * Represents the state of a View.
         */
        export class ObservingDNode extends RootDNode {
            isSleeping = true; // isSleeping: nobody is observing this dependency node, so don't bother tracking DNode's this DNode depends on
            hasCycle = false;  // this node is part of a cycle, which is an error
            observing: RootDNode[] = [];       // nodes we are looking at. Our value depends on these nodes
            private prevObserving: _.RootDNode[] = null; // nodes we were looking at before. Used to determine changes in the dependency tree
            private dependencyChangeCount = 0;     // nr of nodes being observed that have received a new value. If > 0, we should recompute
            private dependencyStaleCount = 0;      // nr of nodes being observed that are currently not ready

            setRefCount(delta:number) {
                var rc = this.externalRefenceCount += delta;
                if (rc === 0)
                    this.tryToSleep();
                else if (rc === delta) // a.k.a. rc was zero.
                    this.wakeUp();
            }

            removeObserver(node:ObservingDNode) {
                super.removeObserver(node);
                this.tryToSleep();
            }

            tryToSleep() {
                if (!this.isSleeping && this.observers.length === 0 && this.externalRefenceCount === 0) {
                    for (var i = 0, l = this.observing.length; i < l; i++)
                        this.observing[i].removeObserver(this);
                    this.observing = [];
                    this.isSleeping = true;
                }
            }

            wakeUp() {
                if (this.isSleeping) {
                    this.isSleeping = false;
                    this.state = DNodeState.PENDING;
                    this.computeNextState();
                }
            }

            // the state of something we are observing has changed..
            notifyStateChange(observable:RootDNode, stateDidActuallyChange:boolean) {
                if (observable.state === DNodeState.STALE) {
                    if (++this.dependencyStaleCount === 1)
                        this.markStale();
                } else { // not stale, thus ready since pending states are not propagated
                    if (stateDidActuallyChange)
                        this.dependencyChangeCount += 1;
                    if (--this.dependencyStaleCount === 0) { // all dependencies are ready
                        this.state = DNodeState.PENDING;
                        Scheduler.schedule(() => {
                            // did any of the observables really change?
                            if (this.dependencyChangeCount > 0)
                                this.computeNextState();
                            else
                                // we're done, but didn't change, lets make sure verybody knows..
                                this.markReady(false);
                            this.dependencyChangeCount = 0;
                        });
                    }
                }
            }

            computeNextState() {
                this.trackDependencies();
                if (_.transitionTracker)
                    _.reportTransition(this, "PENDING");
                var stateDidChange = this.compute();
                this.bindDependencies();
                this.markReady(stateDidChange);
            }

            compute():boolean {
                throw  "Abstract!";
            }

            private trackDependencies() {
                this.prevObserving = this.observing;
                this.observing = [];
                __mobservableViewStack[__mobservableViewStack.length] = this;
            }

            private bindDependencies() {
                 __mobservableViewStack.length -= 1;

                if (this.observing.length === 0 && logLevel > 1 && !this.isDisposed) {
                    console.error("[mobservable] You have created a view function that doesn't observe any values, did you forget to make its dependencies observable?");
                }

                var [added, removed] = quickDiff(this.observing, this.prevObserving);
                this.prevObserving = null;

                for(var i = 0, l = removed.length; i < l; i++)
                    removed[i].removeObserver(this);

                this.hasCycle = false;
                for(var i = 0, l = added.length; i < l; i++) {
                    var dependency = added[i];
                    if (dependency instanceof ObservingDNode && dependency.findCycle(this)) {
                        this.hasCycle = true;
                        // don't observe anything that caused a cycle, or we are stuck forever!
                        this.observing.splice(this.observing.indexOf(added[i]), 1);
                        dependency.hasCycle = true; // for completeness sake..
                    } else {
                        added[i].addObserver(this);
                    }
                }
            }

            private findCycle(node:RootDNode) {
                var obs = this.observing;
                if (obs.indexOf(node) !== -1)
                    return true;
                for(var l = obs.length, i = 0; i < l; i++)
                    if (obs[i] instanceof ObservingDNode && (<ObservingDNode>obs[i]).findCycle(node))
                        return true;
                return false;
            }

            public dispose() {
                if (this.observing) for(var l=this.observing.length, i=0; i<l; i++)
                    this.observing[i].removeObserver(this);
                this.observing = null;
                super.dispose();
            }
        }

        export function stackDepth () {
            return __mobservableViewStack.length;
        }
        
        export function isComputingView() {
            return __mobservableViewStack.length > 0;
        }
    }
}