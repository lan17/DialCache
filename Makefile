.DEFAULT_GOAL := help
# A single checkout owns the corpus and completion reports. Separate CI jobs
# may run independently; parallel goals in this checkout must keep phase order.
.NOTPARALLEL:

NODE ?= node

.PHONY: integration-wire

.PHONY: help check check-ts check-go check-rust check-python docs audit smoke formal formal-check formal-generate formal-ts formal-go formal-rust formal-python fixtures-check kernel-fixtures differential mutations mutations-ts mutations-go mutations-merge-ts mutations-merge-go mutations-rust mutations-merge-rust integration integration-ts integration-go integration-rust integration-python package-floor ci explore model-check

help check check-ts check-go check-rust check-python docs audit smoke formal formal-check formal-generate formal-ts formal-go formal-rust formal-python fixtures-check kernel-fixtures differential mutations mutations-ts mutations-go mutations-merge-ts mutations-merge-go mutations-rust mutations-merge-rust integration integration-ts integration-go integration-rust integration-python integration-wire package-floor ci explore model-check:
	$(NODE) formal/validation.mjs $@
