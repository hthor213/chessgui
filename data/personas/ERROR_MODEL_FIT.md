# Corpus error model — fitted surfaces (spec 214 contract step 5)

_fit_error_model.py v1 · 2026-07-16T08:55 · 758,199,951 moves / 110,738,935 mistakes (global rate 0.146) · method: hierarchical shrinkage (pseudo-count 200: global->band->phase->clock->cell) + 1-2-1 kernel over the eval axis, support-weighted._

Mistake = mover-POV [%eval] drop >= 1.0 pawn (no engine re-verification — distributional model, see scripts/mining/error_model.py). Eval buckets are the mover-POV eval BEFORE the move (50 cp, clamped to [-5, +5)); clock buckets are remaining seconds. HOW THIS SHIPS: consumed by tune_persona.py --error-model as a gated candidate arm — a persona config gets `sampling.error_model` ONLY on a held-out +2% move-match@1 win.

## Band 1400

79,791,253 moves, 14,019,592 mistakes, raw rate 0.175703.

Fitted mean rate by phase x clock (mean over eval buckets):

| phase | 600plus | 300-600 | 120-300 | 60-120 | 30-60 | lt30 | none |
|---|--:|--:|--:|--:|--:|--:|--:|
| opening | 0.173 | 0.188 | 0.139 | 0.103 | 0.113 | 0.109 | 0.074 |
| middlegame | 0.212 | 0.227 | 0.273 | 0.291 | 0.318 | 0.348 | 0.219 |
| endgame | 0.209 | 0.213 | 0.231 | 0.239 | 0.254 | 0.274 | 0.172 |

Middlegame eval curve (fitted rate at bucket lower edge, ample clock `600plus`):

| eval | -5.0 | -3.0 | -1.0 | +0.0 | +1.0 | +3.0 | +4.5 |
|---|--:|--:|--:|--:|--:|--:|--:|
| rate | 0.203 | 0.235 | 0.198 | 0.150 | 0.214 | 0.248 | 0.174 |

## Band 1500

102,637,570 moves, 17,304,902 mistakes, raw rate 0.168602.

Fitted mean rate by phase x clock (mean over eval buckets):

| phase | 600plus | 300-600 | 120-300 | 60-120 | 30-60 | lt30 | none |
|---|--:|--:|--:|--:|--:|--:|--:|
| opening | 0.177 | 0.188 | 0.141 | 0.105 | 0.122 | 0.083 | 0.068 |
| middlegame | 0.202 | 0.218 | 0.261 | 0.280 | 0.306 | 0.339 | 0.209 |
| endgame | 0.198 | 0.203 | 0.223 | 0.231 | 0.247 | 0.267 | 0.168 |

Middlegame eval curve (fitted rate at bucket lower edge, ample clock `600plus`):

| eval | -5.0 | -3.0 | -1.0 | +0.0 | +1.0 | +3.0 | +4.5 |
|---|--:|--:|--:|--:|--:|--:|--:|
| rate | 0.210 | 0.230 | 0.185 | 0.136 | 0.197 | 0.233 | 0.164 |

## Band 1600

104,251,668 moves, 16,598,953 mistakes, raw rate 0.15922.

Fitted mean rate by phase x clock (mean over eval buckets):

| phase | 600plus | 300-600 | 120-300 | 60-120 | 30-60 | lt30 | none |
|---|--:|--:|--:|--:|--:|--:|--:|
| opening | 0.155 | 0.172 | 0.128 | 0.115 | 0.084 | 0.091 | 0.055 |
| middlegame | 0.186 | 0.206 | 0.249 | 0.268 | 0.295 | 0.327 | 0.198 |
| endgame | 0.191 | 0.195 | 0.215 | 0.225 | 0.242 | 0.262 | 0.165 |

Middlegame eval curve (fitted rate at bucket lower edge, ample clock `600plus`):

| eval | -5.0 | -3.0 | -1.0 | +0.0 | +1.0 | +3.0 | +4.5 |
|---|--:|--:|--:|--:|--:|--:|--:|
| rate | 0.191 | 0.210 | 0.165 | 0.120 | 0.181 | 0.220 | 0.157 |

## Band 1700

108,098,669 moves, 16,323,952 mistakes, raw rate 0.15101.

Fitted mean rate by phase x clock (mean over eval buckets):

| phase | 600plus | 300-600 | 120-300 | 60-120 | 30-60 | lt30 | none |
|---|--:|--:|--:|--:|--:|--:|--:|
| opening | 0.146 | 0.164 | 0.123 | 0.080 | 0.072 | 0.065 | 0.047 |
| middlegame | 0.174 | 0.195 | 0.237 | 0.257 | 0.283 | 0.318 | 0.187 |
| endgame | 0.180 | 0.186 | 0.207 | 0.217 | 0.233 | 0.256 | 0.160 |

Middlegame eval curve (fitted rate at bucket lower edge, ample clock `600plus`):

| eval | -5.0 | -3.0 | -1.0 | +0.0 | +1.0 | +3.0 | +4.5 |
|---|--:|--:|--:|--:|--:|--:|--:|
| rate | 0.189 | 0.199 | 0.148 | 0.105 | 0.165 | 0.205 | 0.150 |

## Band 1800

108,048,885 moves, 15,448,809 mistakes, raw rate 0.14298.

Fitted mean rate by phase x clock (mean over eval buckets):

| phase | 600plus | 300-600 | 120-300 | 60-120 | 30-60 | lt30 | none |
|---|--:|--:|--:|--:|--:|--:|--:|
| opening | 0.135 | 0.155 | 0.118 | 0.097 | 0.079 | 0.077 | 0.039 |
| middlegame | 0.162 | 0.185 | 0.226 | 0.248 | 0.273 | 0.307 | 0.177 |
| endgame | 0.169 | 0.177 | 0.198 | 0.210 | 0.227 | 0.249 | 0.155 |

Middlegame eval curve (fitted rate at bucket lower edge, ample clock `600plus`):

| eval | -5.0 | -3.0 | -1.0 | +0.0 | +1.0 | +3.0 | +4.5 |
|---|--:|--:|--:|--:|--:|--:|--:|
| rate | 0.187 | 0.189 | 0.133 | 0.092 | 0.149 | 0.191 | 0.143 |

## Band 1900

92,271,220 moves, 12,436,464 mistakes, raw rate 0.134782.

Fitted mean rate by phase x clock (mean over eval buckets):

| phase | 600plus | 300-600 | 120-300 | 60-120 | 30-60 | lt30 | none |
|---|--:|--:|--:|--:|--:|--:|--:|
| opening | 0.123 | 0.145 | 0.108 | 0.053 | 0.043 | 0.060 | 0.033 |
| middlegame | 0.149 | 0.175 | 0.214 | 0.237 | 0.265 | 0.298 | 0.167 |
| endgame | 0.157 | 0.168 | 0.189 | 0.202 | 0.220 | 0.244 | 0.149 |

Middlegame eval curve (fitted rate at bucket lower edge, ample clock `600plus`):

| eval | -5.0 | -3.0 | -1.0 | +0.0 | +1.0 | +3.0 | +4.5 |
|---|--:|--:|--:|--:|--:|--:|--:|
| rate | 0.187 | 0.178 | 0.116 | 0.079 | 0.133 | 0.172 | 0.133 |

## Band 2000

68,506,162 moves, 8,571,537 mistakes, raw rate 0.125121.

Fitted mean rate by phase x clock (mean over eval buckets):

| phase | 600plus | 300-600 | 120-300 | 60-120 | 30-60 | lt30 | none |
|---|--:|--:|--:|--:|--:|--:|--:|
| opening | 0.107 | 0.133 | 0.090 | 0.066 | 0.047 | 0.026 | 0.026 |
| middlegame | 0.135 | 0.163 | 0.200 | 0.225 | 0.253 | 0.287 | 0.155 |
| endgame | 0.144 | 0.156 | 0.178 | 0.191 | 0.210 | 0.236 | 0.142 |

Middlegame eval curve (fitted rate at bucket lower edge, ample clock `600plus`):

| eval | -5.0 | -3.0 | -1.0 | +0.0 | +1.0 | +3.0 | +4.5 |
|---|--:|--:|--:|--:|--:|--:|--:|
| rate | 0.181 | 0.165 | 0.098 | 0.065 | 0.114 | 0.153 | 0.121 |

## Band 2100

45,160,022 moves, 5,205,409 mistakes, raw rate 0.115266.

Fitted mean rate by phase x clock (mean over eval buckets):

| phase | 600plus | 300-600 | 120-300 | 60-120 | 30-60 | lt30 | none |
|---|--:|--:|--:|--:|--:|--:|--:|
| opening | 0.080 | 0.118 | 0.074 | 0.032 | 0.030 | 0.023 | 0.019 |
| middlegame | 0.119 | 0.149 | 0.186 | 0.211 | 0.239 | 0.276 | 0.142 |
| endgame | 0.128 | 0.144 | 0.166 | 0.181 | 0.200 | 0.228 | 0.135 |

Middlegame eval curve (fitted rate at bucket lower edge, ample clock `600plus`):

| eval | -5.0 | -3.0 | -1.0 | +0.0 | +1.0 | +3.0 | +4.5 |
|---|--:|--:|--:|--:|--:|--:|--:|
| rate | 0.175 | 0.150 | 0.081 | 0.051 | 0.095 | 0.132 | 0.106 |

## Band 2200

26,534,410 moves, 2,781,451 mistakes, raw rate 0.104824.

Fitted mean rate by phase x clock (mean over eval buckets):

| phase | 600plus | 300-600 | 120-300 | 60-120 | 30-60 | lt30 | none |
|---|--:|--:|--:|--:|--:|--:|--:|
| opening | 0.062 | 0.100 | 0.056 | 0.044 | 0.042 | 0.014 | 0.015 |
| middlegame | 0.105 | 0.135 | 0.171 | 0.200 | 0.227 | 0.263 | 0.128 |
| endgame | 0.113 | 0.131 | 0.154 | 0.170 | 0.190 | 0.218 | 0.126 |

Middlegame eval curve (fitted rate at bucket lower edge, ample clock `600plus`):

| eval | -5.0 | -3.0 | -1.0 | +0.0 | +1.0 | +3.0 | +4.5 |
|---|--:|--:|--:|--:|--:|--:|--:|
| rate | 0.172 | 0.138 | 0.064 | 0.040 | 0.078 | 0.113 | 0.093 |

## Band 2300

13,922,930 moves, 1,314,401 mistakes, raw rate 0.094405.

Fitted mean rate by phase x clock (mean over eval buckets):

| phase | 600plus | 300-600 | 120-300 | 60-120 | 30-60 | lt30 | none |
|---|--:|--:|--:|--:|--:|--:|--:|
| opening | 0.039 | 0.085 | 0.041 | 0.009 | 0.015 | 0.011 | 0.011 |
| middlegame | 0.087 | 0.120 | 0.155 | 0.186 | 0.215 | 0.249 | 0.113 |
| endgame | 0.091 | 0.118 | 0.141 | 0.157 | 0.181 | 0.209 | 0.117 |

Middlegame eval curve (fitted rate at bucket lower edge, ample clock `600plus`):

| eval | -5.0 | -3.0 | -1.0 | +0.0 | +1.0 | +3.0 | +4.5 |
|---|--:|--:|--:|--:|--:|--:|--:|
| rate | 0.156 | 0.120 | 0.048 | 0.029 | 0.060 | 0.092 | 0.081 |

## Band 2400

6,214,639 moves, 530,840 mistakes, raw rate 0.085418.

Fitted mean rate by phase x clock (mean over eval buckets):

| phase | 600plus | 300-600 | 120-300 | 60-120 | 30-60 | lt30 | none |
|---|--:|--:|--:|--:|--:|--:|--:|
| opening | 0.018 | 0.057 | 0.031 | 0.013 | 0.008 | 0.008 | 0.008 |
| middlegame | 0.072 | 0.106 | 0.142 | 0.178 | 0.206 | 0.246 | 0.100 |
| endgame | 0.076 | 0.104 | 0.128 | 0.148 | 0.172 | 0.207 | 0.110 |

Middlegame eval curve (fitted rate at bucket lower edge, ample clock `600plus`):

| eval | -5.0 | -3.0 | -1.0 | +0.0 | +1.0 | +3.0 | +4.5 |
|---|--:|--:|--:|--:|--:|--:|--:|
| rate | 0.120 | 0.094 | 0.039 | 0.023 | 0.051 | 0.076 | 0.080 |

## Band 2500

2,072,333 moves, 159,191 mistakes, raw rate 0.076817.

Fitted mean rate by phase x clock (mean over eval buckets):

| phase | 600plus | 300-600 | 120-300 | 60-120 | 30-60 | lt30 | none |
|---|--:|--:|--:|--:|--:|--:|--:|
| opening | 0.008 | 0.038 | 0.017 | 0.007 | 0.007 | 0.007 | 0.007 |
| middlegame | 0.052 | 0.091 | 0.128 | 0.167 | 0.200 | 0.243 | 0.088 |
| endgame | 0.073 | 0.088 | 0.113 | 0.131 | 0.158 | 0.197 | 0.102 |

Middlegame eval curve (fitted rate at bucket lower edge, ample clock `600plus`):

| eval | -5.0 | -3.0 | -1.0 | +0.0 | +1.0 | +3.0 | +4.5 |
|---|--:|--:|--:|--:|--:|--:|--:|
| rate | 0.073 | 0.061 | 0.026 | 0.018 | 0.042 | 0.056 | 0.074 |

## Band 2600

512,459 moves, 35,252 mistakes, raw rate 0.06879.

Fitted mean rate by phase x clock (mean over eval buckets):

| phase | 600plus | 300-600 | 120-300 | 60-120 | 30-60 | lt30 | none |
|---|--:|--:|--:|--:|--:|--:|--:|
| opening | 0.005 | 0.017 | 0.012 | 0.006 | 0.006 | 0.006 | 0.006 |
| middlegame | 0.039 | 0.081 | 0.113 | 0.146 | 0.179 | 0.213 | 0.077 |
| endgame | 0.052 | 0.077 | 0.099 | 0.112 | 0.140 | 0.163 | 0.092 |

Middlegame eval curve (fitted rate at bucket lower edge, ample clock `600plus`):

| eval | -5.0 | -3.0 | -1.0 | +0.0 | +1.0 | +3.0 | +4.5 |
|---|--:|--:|--:|--:|--:|--:|--:|
| rate | 0.076 | 0.040 | 0.027 | 0.015 | 0.028 | 0.036 | 0.055 |

## Band 2700

106,457 moves, 6,133 mistakes, raw rate 0.05761.

Fitted mean rate by phase x clock (mean over eval buckets):

| phase | 600plus | 300-600 | 120-300 | 60-120 | 30-60 | lt30 | none |
|---|--:|--:|--:|--:|--:|--:|--:|
| opening | 0.004 | 0.011 | 0.005 | 0.006 | 0.006 | 0.006 | 0.006 |
| middlegame | 0.030 | 0.069 | 0.080 | 0.114 | 0.143 | 0.144 | 0.064 |
| endgame | 0.051 | 0.062 | 0.077 | 0.087 | 0.085 | 0.113 | 0.075 |

Middlegame eval curve (fitted rate at bucket lower edge, ample clock `600plus`):

| eval | -5.0 | -3.0 | -1.0 | +0.0 | +1.0 | +3.0 | +4.5 |
|---|--:|--:|--:|--:|--:|--:|--:|
| rate | 0.063 | 0.027 | 0.018 | 0.010 | 0.026 | 0.038 | 0.045 |

## Band 2800

30,854 moves, 1,226 mistakes, raw rate 0.039736.

Fitted mean rate by phase x clock (mean over eval buckets):

| phase | 600plus | 300-600 | 120-300 | 60-120 | 30-60 | lt30 | none |
|---|--:|--:|--:|--:|--:|--:|--:|
| opening | 0.001 | 0.005 | 0.005 | 0.005 | 0.005 | 0.005 | 0.005 |
| middlegame | 0.015 | 0.043 | 0.060 | 0.076 | 0.052 | 0.064 | 0.040 |
| endgame | 0.034 | 0.050 | 0.055 | 0.081 | 0.066 | 0.096 | 0.060 |

Middlegame eval curve (fitted rate at bucket lower edge, ample clock `600plus`):

| eval | -5.0 | -3.0 | -1.0 | +0.0 | +1.0 | +3.0 | +4.5 |
|---|--:|--:|--:|--:|--:|--:|--:|
| rate | 0.040 | 0.014 | 0.010 | 0.005 | 0.010 | 0.012 | 0.023 |

## Band 2900

12,362 moves, 234 mistakes, raw rate 0.018929.

Fitted mean rate by phase x clock (mean over eval buckets):

| phase | 600plus | 300-600 | 120-300 | 60-120 | 30-60 | lt30 | none |
|---|--:|--:|--:|--:|--:|--:|--:|
| opening | 0.001 | 0.003 | 0.012 | 0.004 | 0.004 | 0.004 | 0.004 |
| middlegame | 0.005 | 0.017 | 0.025 | 0.013 | 0.007 | 0.017 | 0.014 |
| endgame | 0.023 | 0.024 | 0.025 | 0.052 | 0.032 | 0.056 | 0.033 |

Middlegame eval curve (fitted rate at bucket lower edge, ample clock `600plus`):

| eval | -5.0 | -3.0 | -1.0 | +0.0 | +1.0 | +3.0 | +4.5 |
|---|--:|--:|--:|--:|--:|--:|--:|
| rate | 0.004 | 0.004 | 0.004 | 0.001 | 0.004 | 0.004 | 0.009 |

## Band 3000

27,422 moves, 577 mistakes, raw rate 0.021041.

Fitted mean rate by phase x clock (mean over eval buckets):

| phase | 600plus | 300-600 | 120-300 | 60-120 | 30-60 | lt30 | none |
|---|--:|--:|--:|--:|--:|--:|--:|
| opening | 0.015 | 0.008 | 0.016 | 0.011 | 0.010 | 0.011 | 0.011 |
| middlegame | 0.048 | 0.018 | 0.019 | 0.009 | 0.015 | 0.015 | 0.019 |
| endgame | 0.023 | 0.021 | 0.034 | 0.037 | 0.035 | 0.038 | 0.030 |

Middlegame eval curve (fitted rate at bucket lower edge, ample clock `600plus`):

| eval | -5.0 | -3.0 | -1.0 | +0.0 | +1.0 | +3.0 | +4.5 |
|---|--:|--:|--:|--:|--:|--:|--:|
| rate | 0.113 | 0.062 | 0.026 | 0.010 | 0.035 | 0.043 | 0.057 |

## Band 3100

533 moves, 7 mistakes, raw rate 0.013133.

Fitted mean rate by phase x clock (mean over eval buckets):

| phase | 600plus | 300-600 | 120-300 | 60-120 | 30-60 | lt30 | none |
|---|--:|--:|--:|--:|--:|--:|--:|
| opening | 0.026 | 0.035 | 0.036 | 0.036 | 0.036 | 0.036 | 0.036 |
| middlegame | 0.024 | 0.019 | 0.028 | 0.028 | 0.028 | 0.028 | 0.028 |
| endgame | 0.031 | 0.036 | 0.034 | 0.035 | 0.037 | 0.037 | 0.037 |

Middlegame eval curve (fitted rate at bucket lower edge, ample clock `600plus`):

| eval | -5.0 | -3.0 | -1.0 | +0.0 | +1.0 | +3.0 | +4.5 |
|---|--:|--:|--:|--:|--:|--:|--:|
| rate | 0.024 | 0.024 | 0.024 | 0.022 | 0.022 | 0.023 | 0.028 |

## Band 3200

103 moves, 5 mistakes, raw rate 0.048544.

Fitted mean rate by phase x clock (mean over eval buckets):

| phase | 600plus | 300-600 | 120-300 | 60-120 | 30-60 | lt30 | none |
|---|--:|--:|--:|--:|--:|--:|--:|
| opening | 0.097 | 0.105 | 0.105 | 0.105 | 0.105 | 0.105 | 0.105 |
| middlegame | 0.090 | 0.088 | 0.097 | 0.097 | 0.097 | 0.097 | 0.097 |
| endgame | 0.107 | 0.109 | 0.109 | 0.109 | 0.109 | 0.109 | 0.109 |

Middlegame eval curve (fitted rate at bucket lower edge, ample clock `600plus`):

| eval | -5.0 | -3.0 | -1.0 | +0.0 | +1.0 | +3.0 | +4.5 |
|---|--:|--:|--:|--:|--:|--:|--:|
| rate | 0.091 | 0.093 | 0.089 | 0.090 | 0.090 | 0.090 | 0.089 |
