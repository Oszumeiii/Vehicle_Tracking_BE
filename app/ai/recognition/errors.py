class InvalidImage(ValueError):
    """An input frame could not be safely decoded or preprocessed."""


class InferenceBusy(RuntimeError):
    """The shared inference model is already processing another track."""


class InferenceUnavailable(RuntimeError):
    """The model cannot complete inference with the current resources."""
