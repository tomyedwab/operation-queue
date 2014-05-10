/**
 * Copyright (c) 2014 Khan Academy under the MIT License.
 *
 * A global operation queue for sending content model updates to the server.
 * 
 * The operation queue is built to handle autosave-type operations where
 * client-side changes to models are queued up to be synchronized with the
 * server in the background while the user continues making changes.  The
 * operation queue does not take attributes to apply directly but rather a
 * callback function to apply a particular operation. This allows us to merge
 * in changes from the server with client-side changes because we can re-apply
 * the same operation (for instance, insert an entry in a list) on top of newly
 * refreshed models without overwriting someone else's changes.
 *
 * Operations are combined into entries in the queue by model to minimize the
 * number of save() calls made. At any point there may be up to two entries for
 * a given model: one "in progress" and one "queued". Operations that are
 * redundant (have no effect on the model attributes) are ignored.
 *
 *** Usage: *******
 *
 *   // Create a new Backbone.Model with OperationQueue's mixin functionality
 *
 *   var model = new OperationQueue.ModelMixin(Backbone.Model)();
 *   model.set({ foo: 0 });
 *
 *   // Save some changes to the server (via the model's normal save() method)
 *   // Returns the entry in the queue, which is also a promise.
 *
 *   var entry = model.enqueueOperation(
 *
 *      // The operation to apply. The most common is opSetAttributes, which
 *      // just applies the passed-in attributes directly to the model.
 *      OperationQueue.opSetAttributes,
 *
 *      // Parameters to the operation, in this case a dictionary of attributes
 *      // to set on the model
 *      { foo: 1 });
 *
 *   // At any given moment, the model's attributes track the current server
 *   // state. Pending edits don't show up on the model until save completes.
 *
 *   console.log(model.get("foo")); // prints 0
 *
 *   // We can also check whether an entry is being send and display feedback
 *   // to the user
 *   console.log(!!OperationQueue.currentState.get("saveEntry")); // prints 'true'
 *
 *   // getUIAttributes() returns the current state of the model with all
 *   // enqueued operations applied, so the UI will always show the target
 *   // state rather than the server state
 *
 *   console.log(model.getUIAttributes().foo); // prints 1
 *
 *   // The promise completes when the model has been successfully saved
 *
 *   entry.then(function() {
 *       console.log(model.get("foo")); // prints 1
 *       console.log(!!OperationQueue.currentState.get("saveEntry")); // prints 'false'
 *   }, function(error) {
 *       // We got an error. We can retry here or prompt the user to try
 *       // making their change again
 *
 *       // The UI can detect globally whether there has been an error and
 *       // show it in a centralized location
 *       console.log(OperationQueue.currentState.get("errorModels")); // prints [model]
 *
 *       // The error itself is also stored on the model until it is cleared
 *       // by a successful save
 *       console.log(model.getError()); // prints the error
 *
 *       // The operation queue will attempt to continue saving other models
 *       // even after an error
 *   });
 *   
 *** Conflict handling: *********
 *
 * If the server detects that the base version of the model being saved is
 * older than the latest editing version, it can send back an HTTP
 * 409/Conflict error code. This is handled specially on the client because we
 * can fetch the new version from the server, reapply the operations, and
 * attempt to save again.  Since OperationQueue doesn't assume anything about
 * the fetch/save behavior of the model, it is up to the model class to override
 * handleConflict() in this case and do the appropriate thing. If the promise
 * returned by handleConflict() resolves successfully, then OperationQueue
 * assumes we now have the latest version of the model and it is safe to retry
 * the operation. If the promise returns an error then the queue reports an
 * error for the model.
 *
 * Note that remote changes can still be silently overwritten if two users
 * modify the same field on an entity. It is up to the operation functions to
 * make the minimal change the user requested to minimize potential loss of
 * data. For instance, insertions/deletions from a list should be specialized
 * operations so that multiple insertions/removals to the same list don't
 * overwrite each other.
 *
 * Since the model attributes can be set from either client changes or server
 * updates, there is a getUIAttributes() method on the model to get the latest
 * server state with all pending local changes applied.
 *
 * How this works: (assuming an item model with fields 'title' and 'description')
 *
 *   1. Client A has version 1 of an item.
 *   2. Client B changes the item's description and saves version 2.
 *   3. Client A changes the item's title and OperationQueue calls save() on
 *      the model.
 *   4. The server, seeing that client A had version 1 and it has version 2,
 *      returns a 409/Conflict status.
 *   5. OperationQueue detects the 409 and calls handleConflict() on the model.
 *   6. The model fetches version 2 from the server and notifies the UI that
 *      the description has changed
 *   7. The UI calls getUIAttributes() to get *both* the description and title
 *      change in order to show the updated state while not reverting the
 *      user's change
 *   8. The model resolves the deferred returned by handleConflict().
 *   9. OperationQueue sees that the conflict has been resolved, re-applies the
 *      title change on top of the new model attributes and calls save() again.
 *   10. Now that the version numbers match, the server accepts the save and
 *      updates the title on the item. Both edits have been applied
 *      successfully.
 */

// Depend on Backbone and underscore as AMD modules
var Backbone = require("backbone");
var _ = require("underscore");

var OperationQueue = (function() {
    // A queue of _QueueEntry instances containing pending model operations
    var _queue = [];

    // Whether we've bound our beforeunload handler
    var _boundEvents = false;

    // whether the window is unloading data
    var _unloading = false;

    // Status flags for entries
    var STATE_QUEUED = 'queued';
    var STATE_IN_PROGRESS = 'in_progress';
    var STATE_SUCCESS = 'success';
    var STATE_ERROR = 'error';

    // An entry in the pending queue for a single model containing the
    // operations we'd like to apply to the model
    var _QueueEntry = function(model) {
        this.model = model;
        this.state = STATE_QUEUED;
        this.operations = [];
        this.deferred = $.Deferred();

        this.markSuccess = function() {
            this.model.clearError();
            this.state = STATE_SUCCESS;
            this.deferred.resolve();
        };

        this.markError = function(error) {
            this.model.recordError(error);
            this.state = STATE_ERROR;
            this.deferred.reject(error);
        };

        // Expose a promise API
        this.promise = this.deferred.promise;
        this.state = _.bind(this.deferred.state, this.deferred);
        this.always = _.bind(this.deferred.always, this.deferred);
        this.done = _.bind(this.deferred.done, this.deferred);
        this.then = _.bind(this.deferred.then, this.deferred);
    };

    // Object describing an operation that can be put in the queue
    var _Operation = function(model, applyMethod, attributes) {
        this.model = model;
        this.applyMethod = applyMethod;
        this.attributes = attributes;
        return this;
    };

    // Queues up a new operation
    var _handleQueueRequest = function(op) {
        // Check to see if the model is already queued. If it is not, create
        // a new entry for it.
        var modelEntry = _.find(_queue, function(entry) {
            return entry.model === op.model;
        });
        if (!modelEntry) {
            modelEntry = new _QueueEntry(op.model);
            _queue.push(modelEntry);
        }

        // Add the operation to the queue entry
        modelEntry.operations.push(op);

        // If nothing is currently 'in flight', save the next queued model
        if (OperationQueue.currentState.get("saveEntry") === null) {
            _sendNextEntry();
        }

        return modelEntry;
    };

    // Process the next entry in the queue
    var _sendNextEntry = function() {
        // Get the next entry from the queue
        var entry = _queue.shift();

        // Check if we're done.
        if (!entry) {
            // Trigger any listeners (i.e. the autosave widget) that we're all
            // done with saves
            OperationQueue.currentState.set({saveEntry: null});
            return;
        }

        // Mark the entry "in progress"
        entry.state = STATE_IN_PROGRESS;

        // Apply all the operations in order to the model attributes
        var oldAttrs = entry.model.toJSON();
        var newAttrs = _.reduce(
                entry.operations,
                function(attrs, op) {
                    // Each applyMethod is expected to return a copy of attrs
                    // with some changes made (not just the attributes it
                    // wants to change)
                    return op.applyMethod.call(op, attrs);
                },
                oldAttrs);

        // Now that the operations have all been applied, check to see if
        // there are attribute changes. There may be no changes for instance
        // if a change was made and reverted while the model was in the queue.
        var change = _.find(
                newAttrs,
                function(value, key) {
                    return value !== oldAttrs[key];
                });

        if (change !== undefined) {
            // Make sure the beforeunload handler is bound
            _bindEvents();

            // Update the state
            OperationQueue.currentState.set({saveEntry: entry});

            // Trigger a save to the server. Don't set the model attributes
            // until the save completes successfully. If we want to show the
            // latest version including local edits, call
            // model.getUIAttributes() instead
            entry.model.save(newAttrs, {wait: true}).then(
                // Success!
                function(model) {
                    // Mark the entry complete.
                    entry.markSuccess();

                    // Advance to the next entry in the queue
                    _sendNextEntry();
                },
                // Error
                function(error) {
                    if (error.status === 409) {
                        OperationQueue.currentState.set(
                            "handlingConflict", true);

                        // Special-case for 409/Conflict errors. Give the model
                        // a chance to handle the conflict by getting the
                        // latest version of itself.
                        // handleConflict returns a promise that will tell us
                        // whether it was able to refresh the model so we can
                        // retry the operation.
                        entry.model.handleConflict(
                                JSON.parse(error.responseText)).then(
                            function() {
                                // Success! We can retry the operation.
                                OperationQueue.currentState.set(
                                    "handlingConflict", false);
                                _queue.unshift(entry);
                                _sendNextEntry();
                            },
                            function(error) {
                                // Mark the entry complete.
                                entry.markError(error);

                                // Clear the global state
                                OperationQueue.currentState.set(
                                    "handlingConflict", false);

                                // Advance to the next entry in the queue
                                _sendNextEntry();
                            });
                        return;
                    }
                    
                    // Mark the entry complete.
                    entry.markError(error.responseText);

                    // Advance to the next entry in the queue
                    _sendNextEntry();
                });
        } else {
            // No changes to save, so we can safely mark this complete
            entry.markSuccess();

            // Advance to the next entry in the queue
            _sendNextEntry();
        }
    };

    /*
     * Checks if there are unsaved changes and alerts the user and gives
     * them a chance to avoid losing these changes if there are.
     */
    var _onBeforeUnload = function() {
        _unloading = true;
        if (_queue.length !== 0 ||
                OperationQueue.currentState.get("saveEntry") !== null) {
            return ("Your changes are still being saved. " +
                "If you leave this page you may lose these changes.");
        }
        if (OperationQueue.currentState.get("errorModels").length > 0) {
            return ("Errors occurred while saving your changes. " +
                "If you leave this page you will lose these changes.");
        }
        return;
    };

    // Bind the above event handler once
    var _bindEvents = function() {
        if (!_boundEvents) {
           $(window).on("beforeunload", _onBeforeUnload);
            _boundEvents = true;
        }
    };

    return {
        currentState: new Backbone.Model({
            // The _QueueEntry we are currently sending to the server
            saveEntry: null,

            // List of models that currently have errors trying to save
            errorModels: [],

            // Are we handling a conflict?
            handlingConflict: false
        }),

        ModelMixin: function(parentClass) {
            return parentClass.extend({
                // Add an operation to the queue that will output a set of new
                // attributes to be sent to the server.
                enqueueOperation: function(applyMethod, attributes) {
                    var op = new _Operation(
                        this, applyMethod, attributes);
                    return _handleQueueRequest(op);
                },

                // Record an error that occurred while saving. This error
                // persists until we have successfully saved the model, at
                // which point it will be cleared.
                recordError: function(error) {
                    this._error = error;

                    // Add this model to currentState.errorModels
                    var errorModels = (
                        OperationQueue.currentState.get("errorModels"));
                    if (errorModels.indexOf(this) < 0) {
                        errorModels = _.clone(errorModels);
                        errorModels.push(this);
                        OperationQueue.currentState.set(
                            "errorModels", errorModels);
                    }
                },

                // Clear the error state of this model
                clearError: function() {
                    delete this._error;

                    // Remove this model to currentState.errorModels
                    var errorModels = _.filter(
                        OperationQueue.currentState.get("errorModels"),
                        _.bind(function(model) {
                            return model !== this;
                        }, this));
                    OperationQueue.currentState.set(
                        "errorModels", errorModels);
                },

                // Get the last error saving this model, or undefined
                getError: function() {
                    return this._error;
                },

                // Handle a conflict that can happen if another client has
                // saved a change to the server since we loaded the model.
                // This method is expected to return a promise that resolves
                // if the conflict has been resolved (we've refreshed the model
                // data from the server) and rejects if we cannot resolve the
                // conflict.
                // This is meant to be overridden by subclasses to provide the
                // functionality.
                handleConflict: function(conflictInfo) {
                    return $.Deferred()
                        .reject("Conflict resolution not implemented")
                        .promise();
                },

                // Get the latest version of the model attributes with all
                // locally-applied changes (operations enqueued in the
                // OperationQueue that haven't been sent yet) applied.
                getUIAttributes: function() {
                    var attrs = _.clone(this.attributes);
                    var operations = [];

                    // Check if we're in the process of saving this model
                    var savingEntry = OperationQueue.currentState.get("saveEntry");
                    if (savingEntry && savingEntry.model === this) {
                        operations = operations.concat(savingEntry.operations);
                    }

                    // Check if we have queued up operations on this model
                    var modelEntry = _.find(_queue, _.bind(function(entry) {
                        return entry.model === this;
                    }, this));
                    if (modelEntry) {
                        operations = operations.concat(modelEntry.operations);
                    }
                    return _.reduce(
                        operations,
                        function(attrs, op) {
                            // Each applyMethod is expected to return a
                            // copy of attrs with some changes made (not
                            // just the attributes it wants to change)
                            return op.applyMethod.call(op, attrs);
                        },
                        attrs);
                }
            });
        },

        // applyMethod to just set the attributes directly
        opSetAttributes: function(oldAttrs) {
            var newAttrs = _.clone(oldAttrs);
            
            // Enable nested structure in autosaved models. Without this code,
            // saving a field named extraProperties.originalUrl would attempt to
            // send the whole thing as a single entry. The desired behavior is
            // to send up an extraProperties object with a field originalUrl
            // instead.
            _.each(this.attributes, function(value, attribute) {
                if (attribute.indexOf(".") !== -1) {
                    // If the attribute is of the form "foo.bar: baz", set
                    // newAttrs.foo.bar = baz
                    var splitAttribute = attribute.split(".");
                    newAttrs[splitAttribute[0]] = _.clone(
                        newAttrs[splitAttribute[0]] || {});
                    newAttrs[splitAttribute[0]][splitAttribute[1]] = value;
                } else {
                    // Otherwise the attribute is "foo: baz", set
                    // newAttrs.foo = baz
                    newAttrs[attribute] = value;
                }
            });

            return newAttrs;
        }
    };
})();

// Export the OperationQueue as an AMD module
module.exports = OperationQueue;
