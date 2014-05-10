OperationQueue.js
=================

A reusable operation queue for saving Backbone models to the server. Currently used in the content editing infrastructure for administrators on the [Khan Academy website](http://www.khanacademy.org).

Features
========

* Implemented as a mixin for any existing Backbone model class.
* Queues up changes to Backbone models to send to the server via the standard model save() method.
* Agnostic to where the models are loaded from or any other functionality besides saving.
* Operations are represented by a callback function + data that is applied to the model attributes at save time.
* Special handling for a status code 409/Conflict returned from server to refresh the model and retry.

See operation-queue.js for documentation and details.

Also check out my [blog post](http://arguingwithalgorithms.blogspot.com/2014/05/the-operation-queue-content-editing.html) concerning the motivation and design of this feature.

## License

[MIT License](http://opensource.org/licenses/MIT)
