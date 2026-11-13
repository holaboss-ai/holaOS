---
pretty_name: J
dataset_info:
- config_name: Github_easy
  features:
  - name: json_schema
    dtype: string
  - name: unique_id
    dtype: string
  splits:
  - name: train
    num_bytes: 1208636
    num_examples: 1170
  - name: val
    num_bytes: 182688
    num_examples: 191
  - name: test
    num_bytes: 539656.0
    num_examples: 577
  download_size: 540610
  dataset_size: 1930980.0
- config_name: Github_hard
  features:
  - name: json_schema
    dtype: string
  - name: unique_id
    dtype: string
  splits:
  - name: train
    num_bytes: 12816152
    num_examples: 746
  - name: val
    num_bytes: 1607525
    num_examples: 122
  - name: test
    num_bytes: 5754647.483870967
    num_examples: 368
  download_size: 3562146
  dataset_size: 20178324.48387097
- config_name: Github_medium
  features:
  - name: json_schema
    dtype: string
  - name: unique_id
    dtype: string
  splits:
  - name: train
    num_bytes: 4990832
    num_examples: 1189
  - name: val
    num_bytes: 557390
    num_examples: 194
  - name: test
    num_bytes: 2417201.5784148397
    num_examples: 586
  download_size: 1580336
  dataset_size: 7965423.57841484
- config_name: Github_trivial
  features:
  - name: json_schema
    dtype: string
  - name: unique_id
    dtype: string
  splits:
  - name: train
    num_bytes: 467333.24324324325
    num_examples: 266
  - name: val
    num_bytes: 77303.24324324324
    num_examples: 44
  - name: test
    num_bytes: 235423.51351351352
    num_examples: 134
  download_size: 158044
  dataset_size: 780060.0
- config_name: Github_ultra
  features:
  - name: json_schema
    dtype: string
  - name: unique_id
    dtype: string
  splits:
  - name: train
    num_bytes: 7311744.743902439
    num_examples: 98
  - name: val
    num_bytes: 1193754.243902439
    num_examples: 16
  - name: test
    num_bytes: 3730482.012195122
    num_examples: 50
  download_size: 2221455
  dataset_size: 12235981.0
- config_name: Glaiveai2K
  features:
  - name: json_schema
    dtype: string
  - name: unique_id
    dtype: string
  splits:
  - name: train
    num_bytes: 865943.3989455184
    num_examples: 1026
  - name: val
    num_bytes: 141791.9015817223
    num_examples: 168
  - name: test
    num_bytes: 432971.6994727592
    num_examples: 513
  download_size: 284264
  dataset_size: 1440707.0
- config_name: JsonSchemaStore
  features:
  - name: json_schema
    dtype: string
  - name: unique_id
    dtype: string
  splits:
  - name: train
    num_bytes: 13308367.977642277
    num_examples: 295
  - name: val
    num_bytes: 2210542.4776422763
    num_examples: 49
  - name: test
    num_bytes: 6676740.544715447
    num_examples: 148
  download_size: 4019966
  dataset_size: 22195651.0
- config_name: Kubernetes
  features:
  - name: json_schema
    dtype: string
  - name: unique_id
    dtype: string
  splits:
  - name: train
    num_bytes: 15388503.69924812
    num_examples: 639
  - name: val
    num_bytes: 2528627.3684210526
    num_examples: 105
  - name: test
    num_bytes: 7706292.932330827
    num_examples: 320
  download_size: 6819424
  dataset_size: 25623424.0
- config_name: Snowplow
  features:
  - name: json_schema
    dtype: string
  - name: unique_id
    dtype: string
  splits:
  - name: train
    num_bytes: 969083.2952853598
    num_examples: 242
  - name: val
    num_bytes: 160179.0570719603
    num_examples: 40
  - name: test
    num_bytes: 484541.6476426799
    num_examples: 121
  download_size: 298277
  dataset_size: 1613804.0
- config_name: WashingtonPost
  features:
  - name: json_schema
    dtype: string
  - name: unique_id
    dtype: string
  splits:
  - name: train
    num_bytes: 1604526.016
    num_examples: 74
  - name: val
    num_bytes: 281876.192
    num_examples: 13
  - name: test
    num_bytes: 823945.792
    num_examples: 38
  download_size: 565170
  dataset_size: 2710348.0
- config_name: default
  features:
  - name: json_schema
    dtype: string
  - name: unique_id
    dtype: string
  splits:
  - name: train
    num_bytes: 54520620
    num_examples: 5754
  - name: val
    num_bytes: 15255546
    num_examples: 937
  - name: test
    num_bytes: 27031812.394351464
    num_examples: 2867
  download_size: 20765998
  dataset_size: 96807978.39435147
configs:
- config_name: Github_easy
  data_files:
  - split: train
    path: Github_easy/train-*
  - split: val
    path: Github_easy/val-*
  - split: test
    path: Github_easy/test-*
- config_name: Github_hard
  data_files:
  - split: train
    path: Github_hard/train-*
  - split: val
    path: Github_hard/val-*
  - split: test
    path: Github_hard/test-*
- config_name: Github_medium
  data_files:
  - split: train
    path: Github_medium/train-*
  - split: val
    path: Github_medium/val-*
  - split: test
    path: Github_medium/test-*
- config_name: Github_trivial
  data_files:
  - split: train
    path: Github_trivial/train-*
  - split: val
    path: Github_trivial/val-*
  - split: test
    path: Github_trivial/test-*
- config_name: Github_ultra
  data_files:
  - split: train
    path: Github_ultra/train-*
  - split: val
    path: Github_ultra/val-*
  - split: test
    path: Github_ultra/test-*
- config_name: Glaiveai2K
  data_files:
  - split: train
    path: Glaiveai2K/train-*
  - split: val
    path: Glaiveai2K/val-*
  - split: test
    path: Glaiveai2K/test-*
- config_name: JsonSchemaStore
  data_files:
  - split: train
    path: JsonSchemaStore/train-*
  - split: val
    path: JsonSchemaStore/val-*
  - split: test
    path: JsonSchemaStore/test-*
- config_name: Kubernetes
  data_files:
  - split: train
    path: Kubernetes/train-*
  - split: val
    path: Kubernetes/val-*
  - split: test
    path: Kubernetes/test-*
- config_name: Snowplow
  data_files:
  - split: train
    path: Snowplow/train-*
  - split: val
    path: Snowplow/val-*
  - split: test
    path: Snowplow/test-*
- config_name: WashingtonPost
  data_files:
  - split: train
    path: WashingtonPost/train-*
  - split: val
    path: WashingtonPost/val-*
  - split: test
    path: WashingtonPost/test-*
- config_name: default
  data_files:
  - split: train
    path: data/train-*
  - split: val
    path: data/val-*
  - split: test
    path: data/test-*
license: mit
task_categories:
- text-generation
---

# JSONSchemaBench

[![Paper](https://img.shields.io/badge/Paper-arXiv-blue)](https://arxiv.org/abs/2501.10868)
[![GitHub](https://img.shields.io/badge/Code-GitHub-blue)](https://github.com/guidance-ai/jsonschemabench)

JSONSchemaBench is a benchmark of **real-world JSON schemas** designed to evaluate **structured output generation** for Large Language Models (LLMs). It contains approximately **10,000 JSON schemas**, capturing diverse constraints and complexities.


```python
import datasets
from datasets import load_dataset

def main():
    # Inspect the available subsets of the dataset
    all_subsets = datasets.get_dataset_config_names("epfl-dlab/JSONSchemaBench")
    print("Available subsets:", all_subsets)
    # Example output: ['Github_easy', 'Github_hard', 'Github_medium', 'Github_trivial', 'Github_ultra', 'Glaiveai2K', 'JsonSchemaStore', 'Kubernetes', 'Snowplow', 'WashingtonPost', 'default']

    # Access a specific subset of the dataset
    subset_name = "Github_easy"
    github_easy = load_dataset("epfl-dlab/JSONSchemaBench", subset_name)
    print(f"Loaded subset '{subset_name}':", github_easy)

    # Load the entire dataset as a whole
    entire_dataset = load_dataset("epfl-dlab/JSONSchemaBench", "default")
    print("Loaded entire dataset:", entire_dataset)

if __name__ == "__main__":
    main()
```

## Update (March 31st, 2025)

To improve inference efficiency and streamline data collation, we’ve decided to drop a small number of exceptionally long samples from the dataset.

We’re using the `meta-llama/Llama-3.2-1B-instruct` tokenizer, and the filtering criteria are as follows:
- Github_easy: Samples longer than 1024 tokens — 5 out of 582 removed
- Github_medium: Samples longer than 2048 tokens — 7 out of 593 removed
- Github_hard: Samples longer than 8192 tokens — 4 out of 372 removed
- Other subsets are not touched

Since the number of discarded samples is minimal, this change is expected to have at most a 1% impact on results.


## ⚠️ Important Update (March 10th, 2025)

We have restructured the dataset to include train/val/test splits. If you downloaded the dataset before this date, you might encounter errors like `KeyError: 'Github_easy'`.

To fix this issue, please follow one of the options below:

1. Update How Subsets Are Accessed:
If you previously used:

```python
from datasets import load_dataset, concatenate_datasets, DatasetDict, Dataset

subset: DatasetDict = load_dataset("epfl-dlab/JSONSchemaBench")
subset["Github_easy"]
```
You can update it to:

```python
from datasets import load_dataset, concatenate_datasets, DatasetDict, Dataset

subset: DatasetDict = load_dataset("epfl-dlab/JSONSchemaBench", name="Github_easy")
subset: Dataset = concatenate_datasets([subset["train"], subset["val"], subset["test"]])
```

2. Load the Dataset in the Old Structure:
If you need the previous structure, you can use a specific revision:

```python
dataset = load_dataset("epfl-dlab/JSONSchemaBench", revision="e2ee5fdba65657c60d3a24b321172eb7141f8d73")
```

We apologize for the inconvenience and appreciate your understanding! 😊

## 📌 Dataset Overview
- **Purpose:** Evaluate the **efficiency** and **coverage** of structured output generation.
- **Sources:** GitHub, Kubernetes, API specifications, curated collections.
- **Schemas:** Categorized based on complexity and domain.

### 📊 Dataset Breakdown
| Dataset         | Category            | Count |
| --------------- | ------------------- | ----- |
| GlaiveAI-2K     | Function Call       | 1707  |
| Github-Trivial  | Misc                | 444   |
| Github-Easy     | Misc                | 1943  |
| Snowplow        | Operational API     | 403   |
| Github-Medium   | Misc                | 1976  |
| Kubernetes      | Kubernetes API      | 1064  |
| Washington Post | Resource Access API | 125   |
| Github-Hard     | Misc                | 1240  |
| JSONSchemaStore | Misc                | 492   |
| Github-Ultra    | Misc                | 164   |
| **Total**       |                     | 9558  |

## 📥 Loading the Dataset

```python
from datasets import load_dataset

dataset = load_dataset("epfl-dlab/JSONSchemaBench")
print(dataset)
```

## 🔍 Data Structure
Each dataset split contains:
- `"json_schema"`: The schema definition.
- `"unique_id"`: A unique identifier for the schema.


🚀 **For more details, check out the [paper](https://arxiv.org/abs/2501.10868).**

## 📚 Citation
```bibtex
@misc{geng2025jsonschemabench,
      title={Generating Structured Outputs from Language Models: Benchmark and Studies},
      author={Saibo Geng et al.},
      year={2025},
      eprint={2501.10868},
      archivePrefix={arXiv},
      primaryClass={cs.CL},
      url={https://arxiv.org/abs/2501.10868}
}
```


## License

This dataset is provided under the [MIT License](https://opensource.org/licenses/MIT). Please ensure that you comply with the license terms when using or distributing this dataset.

## Acknowledgements

We would like to thank the contributors and maintainers of the JSON schema projects and the open-source community for their invaluable work and support.