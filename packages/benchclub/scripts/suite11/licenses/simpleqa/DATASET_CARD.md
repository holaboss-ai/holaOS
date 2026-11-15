---
license: mit
task_categories:
- question-answering
language:
- en
tags:
- factuality
- parametric
- memory
- pretraining
- posttraining
- benchmark
- simpleqa
- OpenAI
- Google DeepMind
- Google Research
pretty_name: SimpleQA Verified
size_categories:
- 1K<n<10K
configs:
  - config_name: simpleqa_verified
    default: true
    data_files:
      - split: eval
        path: simpleqa_verified.csv
---
# SimpleQA Verified
#### A 1,000-prompt factuality benchmark from Google DeepMind and Google Research, designed to reliably evaluate LLM parametric knowledge. 

▶ [SimpleQA Verified Leaderboard on Kaggle](https://www.kaggle.com/benchmarks/deepmind/simpleqa-verified)\
▶ [Technical Report](https://arxiv.org/abs/2509.07968)\
▶ [Evaluation Starter Code](https://www.kaggle.com/code/nanliao7/simpleqa-verified-benchmark-starter-code)


## Benchmark

SimpleQA Verified is a 1,000-prompt benchmark for reliably evaluating Large Language Models (LLMs) on short-form factuality 
and parametric knowledge. The authors from Google DeepMind and Google Research build on [SimpleQA](https://openai.com/index/introducing-simpleqa/), 
originally designed by [Wei et al. (2024)](https://arxiv.org/abs/2411.04368) at OpenAI, and address limitations including noisy and incorrect labels, topical biases, and question redundancy. 
Similar to SimpleQA, model responses are graded with a GPT-4.1 version. The autorater prompt has been modified with a focus on forcing direct answers, 
preventing guessing in long responses, and improving the grading of numeric answer types. SimpleQA Verified was created to provide the research 
community with a more precise instrument to track genuine progress in factuality, 
discourage overfitting to benchmark artifacts, and ultimately foster the development of more trustworthy AI systems. 

## Dataset Description

This dataset is a collection 1,000 examples crafted by humans for evaluating short-format parametric factuality in LLMs. Each example is composed of:

* An index (`original_index`) indicating which questions in the original [SimpleQA](https://openai.com/index/introducing-simpleqa/) benchmark the example corresponds to
* A problem (`problem`) which is the prompt testing parametric knowledge, e.g. "*To whom did Mehbooba Mufti Sayed contest the 2019 Lok Sabha elections and lose?*"
* A gold answer (`answer`) which is used in conjunction with the evaluation prompt to judge the correctness of an LLM's response
* A topic (`topic`) and answer type (`answer_type`) classification – from the original [SimpleQA](https://openai.com/index/introducing-simpleqa/) paper, and re-classified where appropriate
* Two additional metadata fields `multi_step` and `requires_reasoning` indicating whether the question requires information from multiple sources and whether it requires more complex reasoning
* Golden URLs (`urls`) which are a list of at least two URLs supporting the gold answer (`answer`), collected from SimpleQA human raters and adjusted by the authors of SimpleQA Verified

See the [Technical Report](https://arxiv.org/abs/2509.07968) for methodology details.

## Limitations
SimpleQA Verified is meant to be be used without any tools (i.e. search or retrieval tools). With tools, the benchmark is trivial to solve which defeats its purpose.

Questions, comments, or issues? Share your thoughts with us in the [discussion forum](https://www.kaggle.com/benchmarks/deepmind/simpleqa-verified/discussion?sort=hotness).

## Evaluation Prompt
The evaluation prompt employed by SimpleQA Verified using GPT-4.1 as an autorater mode can be found in the [starter notebook](https://www.kaggle.com/code/nanliao7/simpleqa-verified-benchmark-starter-code) on Kaggle.

## Citation

If you use this dataset in your research, please cite our technical report:
```
@misc{haas2025simpleqaverifiedreliablefactuality,
      title={SimpleQA Verified: A Reliable Factuality Benchmark to Measure Parametric Knowledge}, 
      author={Lukas Haas and Gal Yona and Giovanni D'Antonio and Sasha Goldshtein and Dipanjan Das},
      year={2025},
      eprint={2509.07968},
      archivePrefix={arXiv},
      primaryClass={cs.CL},
      url={https://arxiv.org/abs/2509.07968}, 
}
```