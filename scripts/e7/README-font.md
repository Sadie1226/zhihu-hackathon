# E7扩展像素字体

现有900字领养页子集不覆盖来信标题/动态内容，浏览器混入系统字体导致字形基线与风格不齐。E7单独引用kanshan-journal-complete-v1.woff2，保留旧字库和其他页面不动；新资产27942字符，约1.02MiB，覆盖Windows SimSun源支持的基本汉字/扩展A及指定标点，不承诺全部Unicode。

可选离线重建：`python scripts/e7/build-journal-font.py`。依赖Windows SimSun、Pillow、fonttools[woff]，不是运行时依赖；约数分钟，输出字库和journal-font-audit.json。只向既有字体添加缺字，使用原16px网格/64单位轮廓，保留原字形及度量。运行后按SHA和浏览器实际渲染核验，不用逐字CSS偏移。

11/27 A已核用户所报“修鞋摊旁边的搪瓷缸”：修前custom4/系统5，修后custom9/系统0。E7/E9 24测试与320/375/1440三组布局/来源重试/已读失败脚本通过。业务、字号、渐显参数未改。
