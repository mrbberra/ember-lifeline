import Ember from 'ember';

const {
  Mixin,
  run,
  assert
} = Ember;

let _shouldPollOverride;
function shouldPoll() {
  if (_shouldPollOverride) {
    return _shouldPollOverride();
  }

  // eslint-disable-next-line ember-suave/no-direct-property-access
  return !Ember.testing;
}

export function setShouldPoll(callback) {
  _shouldPollOverride = callback;
}

let queuedPollTasks = {};
let pollTaskLabels = {};
export function pollTaskFor(label) {
  assert(`A pollTask with a label of '${label}' was not found.`, pollTaskLabels[label]);
  assert(`You cannot advance a pollTask (\`${label}\`) when \`next\` has not been called.`, !!queuedPollTasks[label]);

  return run.join(null, queuedPollTasks[label]);
}

/**
 ContextBoundTasksMixin provides a mechanism to run tasks (ala `setTimeout` or
 `Ember.run.later`) with automatic cancellation when the host object is
 destroyed.

 These capabilities are very commonly needed, so this mixin is by default
 included into all `Ember.View`, `Ember.Component`, and `Ember.Service` instances.

 @class ContextBoundTasksMixin
 @public
 */
export default Mixin.create({
  init() {
    this._super(...arguments);

    this._pendingTimers = undefined;
    this._pendingDebounces = undefined;
    this._pollerLabels = undefined;
    this._registeredDisposables = undefined;
  },

  /**
   Runs the provided function at the specified timeout (defaulting to 0).
   The timer is properly canceled if the object is destroyed before it is invoked.

   Example:

   ```js
   import Component from 'ember-component';
   import ContextBoundTasksMixin from 'ember-lifeline/mixins/run';

   export default Component.extend(ContextBoundTasksMixin, {
     didInsertElement() {
       this.runTask(() => {
         console.log('This runs after 5 seconds if this component is still displayed');
       }, 5000)
     }
   });
   ```

   @method runTask
   @param { Function } callback the callback to run at the provided time
   @param { Number } [timeout=0] the time in the future to run the callback
   @public
   */
  runTask(callbackOrName, timeout = 0) {
    assert(`Called \`runTask\` on destroyed object: ${this}.`, !this.isDestroyed);

    let type = typeof callbackOrName;
    let pendingTimers = this._getOrAllocateArray('_pendingTimers');

    let cancelId = run.later(() => {
      let cancelIndex = pendingTimers.indexOf(cancelId);
      pendingTimers.splice(cancelIndex, 1);

      if (type === 'function') {
        callbackOrName.call(this);
      } else if (type === 'string' && this[callbackOrName]) {
        this[callbackOrName]();
      } else {
        throw new Error('You must pass a callback function or method name to `runTask`.');
      }
    }, timeout);

    pendingTimers.push(cancelId);
    return cancelId;
  },

  /**
   Cancel a previously scheduled task.

   Example:

   ```js
   import Component from 'ember-component';
   import ContextBoundTasksMixin from 'ember-lifeline/mixins/run';

   export default Component.extend(ContextBoundTasksMixin, {
     didInsertElement() {
       this._cancelId = this.runTask(() => {
         console.log('This runs after 5 seconds if this component is still displayed');
       }, 5000)
     },

     disable() {
        this.cancelTask(this._cancelId);
     }
   });
   ```

   @method cancelTask
   @param { Number } cancelId the id returned from the runTask call
   @public
   */
  cancelTask(cancelId) {
    cancelTimer(cancelId);
  },

  /**
   Runs the function with the provided name after the timeout has expired on the last
   invocation. The timer is properly canceled if the object is destroyed before it is
   invoked.

   Example:

   ```js
   import Component from 'ember-component';
   import ContextBoundTasksMixin from 'ember-lifeline/mixins/run';

   export default Component.extend(ContextBoundTasksMixin, {
     logMe() {
       console.log('This will only run once every 300ms.');
     },

     click() {
       this.debounceTask('logMe', 300);
     }
   });
   ```

   @method debounceTask
   @param { String } methodName the name of the method to debounce
   @param { ...* } debounceArgs arguments to pass to the debounced method
   @param { Number } wait the amount of time to wait before calling the method (in milliseconds)
   @public
   */
  debounceTask(name, ...debounceArgs) {
    assert(`Called \`debounceTask\` without a string as the first argument on ${this}.`, typeof name === 'string');
    assert(`Called \`this.debounceTask('${name}', ...)\` where 'this.${name}' is not a function.`, typeof this[name] === 'function');
    assert(`Called \`debounceTask\` on destroyed object: ${this}.`, !this.isDestroyed);

    let pendingDebounces = this._getOrAllocateObject('_pendingDebounces');
    let debounce = pendingDebounces[name];
    let debouncedFn;

    if (!debounce) {
      debouncedFn = (...args) => {
        delete pendingDebounces[name];
        this[name](...args);
      };
    } else {
      debouncedFn = debounce.debouncedFn;
    }

    // cancelId is new, even if the debounced function was already present
    let cancelId = run.debounce(this, debouncedFn, ...debounceArgs);

    pendingDebounces[name] = { debouncedFn, cancelId };
  },

  /**
   Cancel a previously debounced task.

   Example:

   ```js
   import Component from 'ember-component';
   import ContextBoundTasksMixin from 'ember-lifeline/mixins/run';

   export default Component.extend(ContextBoundTasksMixin, {
     logMe() {
       console.log('This will only run once every 300ms.');
     },

     click() {
       this.debounceTask('logMe', 300);
     },

     disable() {
        this.cancelDebounce('logMe');
     }
   });
   ```

   @method cancelDebounce
   @param { String } methodName the name of the debounced method to cancel
   @public
   */
  cancelDebounce(name) {
    cancelDebounce(this._pendingDebounces, name);
  },

  /**
   Runs the function with the provided name immediately, and only once in the time window
   specified by the timeout argument.

   Example:

   ```js
   import Component from 'ember-component';
   import ContextBoundTasksMixin from 'ember-lifeline/mixins/run';

   export default Component.extend(ContextBoundTasksMixin, {
     logMe() {
       console.log('This will run once immediately, then only once every 300ms.');
     },

     click() {
       this.throttleTask('logMe', 300);
     }
   });
   ```

   @method throttleTask
   @param { String } functionName the name of the function to debounce
   @param { Number } [timeout=5] the time in the future to run the callback (defaults to 5ms)
   @public
   */
  throttleTask(name, timeout = 0) {
    assert(`Called \`throttleTask\` without a string as the first argument on ${this}.`, typeof name === 'string');
    assert(`Called \`this.throttleTask('${name}', ${timeout})\` where 'this.${name}' is not a function.`, typeof this[name] === 'function');
    assert(`Called \`throttleTask\` on destroyed object: ${this}.`, !this.isDestroyed);

    run.throttle(this, name, timeout);
  },

  /**
   Sets up a function that can perform polling logic in a testing safe way.
   The callback is invoked synchronously with an argument (generally called `next`).
   In normal development/production when `next` is invoked, it will trigger the
   task again (recursively). However, when in test mode the recursive polling
   functionality is disabled, and usage of the `pollTaskFor` helper is required.

   Example:

   ```js
   // app/components/foo-bar.js
   export default Component.extend({
     api: injectService(),

     init() {
       this._super(...arguments);

       this.pollTask((next) => {
         this.get('api').request('get', 'some/path')
           .then(() => {
             this.runTask(next, 1800);
           })
       }, 'foo-bar#watch-some-path');
     }
   });
   ```

   Test Example:

   ```js
   import wait from 'ember-test-helpers/wait';
   import { pollTaskFor } from 'ember-lifeline/mixins/run';

   //...snip...

   test('foo-bar watches things', function(assert) {
     this.render(hbs`{{foo-bar}}`);

     return wait()
       .then(() => {
         assert.equal(serverRequests, 1, 'called initially');

         pollTaskFor('foo-bar#watch-some-path');
         return wait();
       })
       .then(() => {
         assert.equal(serverRequests, 2, 'called again');
       });
   });
   ```

   @method pollTask
   @param { Function | String } callbackOrMethodName the callback or method name to run
   @param { String } [label] the label for the pollTask to be created
   @public
   */
  pollTask(callbackOrMethodName, label) {
    let next, callback;
    let type = typeof callbackOrMethodName;

    if (type === 'function') {
      callback = callbackOrMethodName;
    } else if (type === 'string' && this[callbackOrMethodName]) {
      callback = this[callbackOrMethodName];
    } else {
      throw new Error('You must pass a callback function or method name to `pollTask`.');
    }

    let tick = () => callback.call(this, next);

    if (label) {
      assert(`The label provided to \`pollTask\` must be unique. \`${label}\` has already been registered.`, !pollTaskLabels[label]);
      pollTaskLabels[label] = true;

      this._getOrAllocateArray('_pollerLabels').push(label);
    }

    if (shouldPoll()) {
      next = tick;
    } else if (label) {
      next = () => {
        queuedPollTasks[label] = tick;
      };
    } else {
      next = () => {};
    }

    callback.call(this, next);
  },

  /**
   Clears a previously setup polling task.

   Example:

   ```js
   // app/components/foo-bar.js
   export default Component.extend({
     api: injectService(),

     enableAutoRefresh() {
       this.pollTask((next) => {
         this.get('api').request('get', 'some/path')
           .then(() => {
             this.runTask(next, 1800);
           })
       }, 'foo-bar#watch-some-path');
     },

     disableAutoRefresh() {
        this.cancelPoll('foo-bar#watch-some-path');
     }
   });
   ```

   @method cancelPoll
   @param { String } label the label for the pollTask to be cleared
   @public
   */
  cancelPoll(label) {
    cancelPoll(label);
  },

  /**
   Adds a new disposable to the object. A disposable is a function that
   disposes of bindings that are outside of Ember's lifecyle. This essentially
   means you can register a function that you want to run to automatically tear
   down any bindings when the Ember object is destroyed.

   Example:

   ```js
   // app/components/foo-bar.js
   import DOMish from 'some-external-library';

   export default Component.extend({
     init() {
       this.DOMish = new DOMish();

       this.bindEvents();
     },

     bindEvents() {
       this.DOMish.on('foo', Ember.run.bind(this.respondToDomEvent));

       this.domFooToken = this.registerDisposable(() => this.DOMish.off('foo));
     },

     respondToDOMEvent() {
       // do something
     }
   });
   ```

   @method registerDisposable
   @param { Function } disposable
   @returns A label representing the position of the disposable
   @public
   */
  registerDisposable(disposable) {
    if (typeof disposable !== 'function') {
      throw new Error('You must pass a function as a disposable');
    }

    let disposables = this._getOrAllocateArray('_registeredDisposables');

    return disposables.push(disposable) - 1;
  },

  /**
   Runs a disposable identified by the supplied label.

  ```js
   // app/components/foo-bar.js
   import DOMish from 'some-external-library';

   export default Component.extend({
     init() {
       this.DOMish = new DOMish();

       this.bindEvents();
     },

     bindEvents() {
       this.DOMish.on('foo', Ember.run.bind(this.respondToDomEvent));

       this.domFooToken = this.registerDisposable(() => this.DOMish.off('foo));
     },

     respondToDOMEvent() {
       // do something
     },

     actions: {
       cancelDOM() {
         this.runDisposable(this.domFooToken);
       }
     }
   });
   ```

   @param {any} label
   @public
   */
  runDisposable(label) {
    runDisposable(this._registeredDisposables, label);
  },

  willDestroy() {
    this._super(...arguments);

    cancelTimers(this._pendingTimers);
    cancelDebounces(this._pendingDebounces);
    clearPollers(this._pollerLabels);
    runDisposables(this._registeredDisposables);
  },

  _getOrAllocateArray(propertyName) {
    if (!this[propertyName]) {
      this[propertyName] = [];
    }

    return this[propertyName];
  },

  _getOrAllocateObject(propertyName) {
    if (!this[propertyName]) {
      this[propertyName] = {};
    }

    return this[propertyName];
  }
});

function clearPollers(labels) {
  if (!labels || !labels.length) {
    return;
  }

  for (let i = 0; i < labels.length; i++) {
    cancelPoll(labels[i]);
  }
}

function cancelPoll(label) {
  pollTaskLabels[label] = undefined;
  queuedPollTasks[label] = undefined;
}

function cancelTimers(timers) {
  if (!timers || !timers.length) {
    return;
  }

  for (let i = 0; i < timers.length; i++) {
    cancelTimer(timers[i]);
  }
}

function cancelTimer(cancelId) {
  run.cancel(cancelId);
}

function cancelDebounces(pendingDebounces) {
  let debounceNames = pendingDebounces && Object.keys(pendingDebounces);

  if (!debounceNames || !debounceNames.length) {
    return;
  }

  for (let i = 0; i < debounceNames.length; i++) {
    cancelDebounce(pendingDebounces, debounceNames[i]);
  }
}

function cancelDebounce(pendingDebounces, name) {
  let { cancelId } = pendingDebounces[name];
  run.cancel(cancelId);
}

function runDisposables(disposables) {
  if (!disposables) {
    return;
  }

  for (let i = 0, l = disposables.length; i < l; i++) {
    let disposable = disposables.pop();

    disposable();
  }
}

function runDisposable(disposables, label) {
  if (!disposables || label < 0) {
    return;
  }

  let disposable = disposables[label];

  if (disposable) {
    disposables.splice(label, 1);
    disposable();
  }
}
